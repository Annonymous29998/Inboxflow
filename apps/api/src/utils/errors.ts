import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.message,
      code: error.code,
    });
  }

  if (error instanceof ZodError) {
    const first = error.issues[0];
    const path = first?.path?.length ? first.path.join('.') : 'body';
    return reply.status(400).send({
      error: first ? `${path}: ${first.message}` : 'Validation error',
      code: 'VALIDATION_ERROR',
      details: error.issues,
    });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2003') {
      return reply.status(400).send({
        error: 'Linked record not found (template, list, or provider). Try again without that reference.',
        code: error.code,
      });
    }
    if (error.code === 'P2002') {
      return reply.status(409).send({
        error: 'That record already exists.',
        code: error.code,
      });
    }
    if (error.code === 'P2025') {
      return reply.status(404).send({
        error: 'Record not found. Refresh and try again.',
        code: error.code,
      });
    }
    if (error.code === 'P2022') {
      return reply.status(400).send({
        error: 'Database schema is out of date. Run migrations, then retry.',
        code: error.code,
      });
    }
    return reply.status(400).send({
      error: 'Could not save that change. Refresh and try again.',
      code: error.code,
    });
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return reply.status(400).send({
      error: 'Invalid data for this request. Check list, SMTP, and template, then save again.',
      code: 'VALIDATION',
    });
  }

  // Fastify body too large / content-type errors / rate limit
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: string }).code || '');
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: 'HTML template is too large to upload in one request. Use “Use in campaign” so the server loads it from the saved template.',
        code,
      });
    }
  }

  const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
  if (statusCode === 429) {
    return reply.status(429).send({
      error: 'Too many requests. Wait a few seconds and continue.',
      code: 'RATE_LIMIT',
    });
  }

  console.error(error);
  const message = error instanceof Error ? error.message : '';
  if (/rate limit/i.test(message)) {
    return reply.status(429).send({
      error: 'Too many requests. Wait a few seconds and continue.',
      code: 'RATE_LIMIT',
    });
  }
  return reply.status(400).send({
    error: message && message.length < 180 && !/prisma|invalid `prisma/i.test(message)
      ? message
      : 'Something went wrong. Refresh and try again.',
    code: 'REQUEST_FAILED',
  });
}

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
};

export type JwtPayload = {
  sub: string;
  email: string;
  role: string;
  organizationId: string | null;
  workspaceLocal?: boolean;
};

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: AuthUser;
  }
}

export type AuthenticatedRequest = FastifyRequest & { user: AuthUser };
