import type { FastifyReply, FastifyRequest } from 'fastify';

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
