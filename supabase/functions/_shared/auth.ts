import * as jose from 'npm:jose@5';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse } from './cors.ts';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
}

export function getServiceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase service configuration');
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

export async function verifyInboxFlowJwt(req: Request): Promise<AuthUser | Response> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return jsonResponse({ error: 'Missing authorization header' }, 401);
  }

  const secret = Deno.env.get('JWT_ACCESS_SECRET');
  if (!secret || secret.length < 32) {
    return jsonResponse({ error: 'JWT_ACCESS_SECRET is not configured on Edge Functions' }, 500);
  }

  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, new TextEncoder().encode(secret));
    payload = result.payload;
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const userId = String(payload.sub ?? payload.id ?? '');
  if (!userId) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const db = getServiceClient();
  const { data: user, error } = await db
    .from('User')
    .select('id, email, role, organizationId, status')
    .eq('id', userId)
    .maybeSingle();

  if (error || !user) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
    return jsonResponse({ error: 'Account suspended' }, 401);
  }

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId ?? null,
  };
}

export function requireOrg(organizationId: string | null): string {
  if (!organizationId) {
    throw new Error('Organization required');
  }
  return organizationId;
}
