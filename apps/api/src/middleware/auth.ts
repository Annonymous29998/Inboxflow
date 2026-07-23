import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';
import { AppError } from '../utils/errors.js';
import type { AuthUser } from '../utils/errors.js';
import { hashToken } from '../utils/crypto.js';

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

export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  try {
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
