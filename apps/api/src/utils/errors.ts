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
    if (error.code === 'P2022') {
      return reply.status(500).send({
        error: 'Database schema is out of date. Run migrations, then retry.',
        code: error.code,
      });
    }
    return reply.status(400).send({
      error: error.message,
      code: error.code,
    });
  }

  // Fastify body too large / content-type errors
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: string }).code || '');
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: 'HTML template is too large to upload in one request. Use “Use in campaign” so the server loads it from the saved template.',
        code,
      });
    }
  }

  console.error(error);
  return reply.status(500).send({ error: 'Internal server error' });
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
};

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: AuthUser;
  }
}

export type AuthenticatedRequest = FastifyRequest & { user: AuthUser };
