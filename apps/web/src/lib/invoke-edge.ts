import { FunctionsHttpError } from '@supabase/supabase-js';
import { api } from '@/lib/api';
import { edgeFunctionsEnabled, supabase } from '@/lib/supabase';

async function readFunctionErrorMessage(error: unknown, data: unknown) {
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    return String((data as { error: string }).error);
  }

  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json();
      if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
        return String(payload.error);
      }
    } catch {
      // fall through
    }
  }

  if (error instanceof Error && error.message.includes('Failed to send a request to the Edge Function')) {
    return 'Could not reach the Supabase Edge Function. Deploy functions and set VITE_SUPABASE_URL.';
  }

  if (error instanceof Error && error.message) return error.message;
  return 'Edge function request failed';
}

export async function invokeEdgeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  if (!edgeFunctionsEnabled) {
    throw new Error('Edge functions are not enabled. Set VITE_USE_EDGE_FUNCTIONS=true.');
  }

  const token = api.getToken();
  const { data, error } = await supabase.functions.invoke(name, {
    body,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (error) {
    throw new Error(await readFunctionErrorMessage(error, data));
  }

  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new Error(String((data as { error: string }).error));
  }

  return data as T;
}
