import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';
import { isDesktopHybrid } from '../config/db-kind.js';
import { AppError } from '../utils/errors.js';
import type { AuthUser } from '../utils/errors.js';
import { hashToken } from '../utils/crypto.js';
import {
  isCloudHostedApi,
  isDeviceWorkspacePath,
  orgKeepsWorkspaceOnDevice,
  WORKSPACE_ON_DEVICE_MESSAGE,
} from '../services/email/workspace-residency.js';
import { resolveHybridPayload } from './hybrid-jwt.js';
import { rememberCloudAuthorization } from '../services/email/desktop-cloud-auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    authVia?: 'jwt' | 'apiKey' | 'cookie';
    apiKeyScopes?: string[];
  }
}

function scopesAllow(scopes: string[] | undefined, method: string): boolean {
  if (!scopes || scopes.length === 0) return true;
  if (scopes.includes('*') || scopes.includes('admin')) return true;
  const upper = method.toUpperCase();
  const isRead = upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
  if (isRead) return scopes.includes('read') || scopes.includes('write');
  return scopes.includes('write');
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return (
    (request.cookies?.access_token as string | undefined) ||
    (request.cookies?.accessToken as string | undefined)
  );
}

async function ensureHybridUser(payload: AuthUser & { sub?: string }): Promise<AuthUser> {
  const id = String(payload.sub || payload.id || '').trim();
  const email = String(payload.email || '').toLowerCase().trim() || `${id}@local.inboxflow`;
  const organizationId = String(payload.organizationId || `org-${id}`);
  const role = String(payload.role || 'USER');
  if (!id) throw new AppError(401, 'Unauthorized');

  const slug = `local-${organizationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || id.slice(0, 12)}`;
  const { deviceBoundIp, mergeLicenseBind } = await import('../services/admin/license-bind.js');
  const boundIp = deviceBoundIp();
  const seedSettings = boundIp
    ? mergeLicenseBind({ smtpAllowDirect: false, workspaceLocal: true }, { boundIp, boundAt: new Date().toISOString() })
    : { smtpAllowDirect: false, workspaceLocal: true };
  try {
    await prisma.organization.upsert({
      where: { id: organizationId },
      create: {
        id: organizationId,
        name: email,
        slug,
        sendSettings: seedSettings as object,
      },
      update: {},
    });
    if (boundIp) {
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { sendSettings: true },
      });
      await prisma.organization.update({
        where: { id: organizationId },
        data: {
          sendSettings: mergeLicenseBind(org?.sendSettings, {
            boundIp,
            boundAt: new Date().toISOString(),
          }) as object,
        },
      });
    }
  } catch {
    const found = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!found) throw new AppError(401, 'Unauthorized');
  }

  const localPart = email.split('@')[0] || 'User';
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    const emailTaken = await prisma.user.findUnique({ where: { email } });
    if (emailTaken && emailTaken.id !== id) {
      throw new AppError(401, 'Unauthorized');
    }
    await prisma.user.create({
      data: {
        id,
        email,
        passwordHash: 'hybrid-local-no-password',
        firstName: localPart,
        lastName: '',
        role: role as never,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        organizationId,
      },
    });
  } else {
    await prisma.user.update({
      where: { id },
      data: { email, role: role as never, organizationId, status: 'ACTIVE' },
    });
  }

  return { id, email, role, organizationId };
}

async function assertCloudWorkspaceResidency(request: FastifyRequest) {
  if (!isCloudHostedApi()) return;
  if (!isDeviceWorkspacePath(request.url)) return;
  const user = request.user;
  if (!user) return;
  const org = user.organizationId
    ? await prisma.organization.findUnique({
        where: { id: user.organizationId },
        select: { sendSettings: true },
      })
    : null;
  if (!orgKeepsWorkspaceOnDevice({ sendSettings: org?.sendSettings, role: user.role, email: user.email })) {
    return;
  }
  throw new AppError(409, WORKSPACE_ON_DEVICE_MESSAGE, 'WORKSPACE_ON_DEVICE');
}

export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  try {
    if (isDesktopHybrid()) {
      const token = bearerToken(request);
      if (!token) throw new AppError(401, 'Unauthorized');
      const payload = await resolveHybridPayload(token);
      if (!payload) throw new AppError(401, 'Unauthorized');
      request.user = await ensureHybridUser(payload);
      request.authVia = request.headers.authorization ? 'jwt' : 'cookie';
      rememberCloudAuthorization(
        request.user.organizationId,
        request.headers.authorization || `Bearer ${token}`,
      );
      return;
    }

    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      const keyHash = hashToken(apiKey);
      const record = await prisma.apiKey.findFirst({
        where: { keyHash, revokedAt: null },
        include: { user: true },
      });
      if (!record) throw new AppError(401, 'Invalid API key');
      if (record.expiresAt && record.expiresAt < new Date()) {
        throw new AppError(401, 'API key expired');
      }
      const scopes = Array.isArray(record.scopes) ? (record.scopes as string[]) : [];
      if (!scopesAllow(scopes, request.method)) {
        throw new AppError(403, 'API key scope does not allow this method');
      }
      await prisma.apiKey.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      });
      request.authVia = 'apiKey';
      request.apiKeyScopes = scopes;
      request.user = {
        id: record.userId,
        email: record.user.email,
        role: record.user.role,
        organizationId: record.organizationId,
      };
      await assertCloudWorkspaceResidency(request);
      return;
    }

    // Prefer Authorization header; fall back to httpOnly cookie set by login
    const cookieToken =
      (request.cookies?.access_token as string | undefined) ||
      (request.cookies?.accessToken as string | undefined);
    if (!request.headers.authorization && cookieToken) {
      request.headers.authorization = `Bearer ${cookieToken}`;
      request.authVia = 'cookie';
    }

    await request.jwtVerify();
    const payload = request.user as unknown as AuthUser & { sub?: string };
    const userId = payload.sub ?? payload.id;
    if (!userId) throw new AppError(401, 'Unauthorized');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
      throw new AppError(401, 'Unauthorized');
    }
    if (!request.authVia) request.authVia = 'jwt';
    (request as FastifyRequest & { user: AuthUser }).user = {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    };
    await assertCloudWorkspaceResidency(request);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'Unauthorized');
  }
}

export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest) => {
    if (!roles.includes(request.user.role)) {
      throw new AppError(403, 'Forbidden');
    }
  };
}

export async function optionalAuth(request: FastifyRequest) {
  try {
    await authenticate(request, {} as FastifyReply);
  } catch {
    // public route
  }
}
