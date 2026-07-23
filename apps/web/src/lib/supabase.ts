import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const supabaseFunctionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string | undefined;

export const edgeFunctionsEnabled =
  import.meta.env.VITE_USE_EDGE_FUNCTIONS === 'true' &&
  Boolean(supabaseUrl?.trim()) &&
  Boolean(supabaseAnonKey?.trim());

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    ...(supabaseFunctionsUrl?.trim()
      ? { functions: { url: supabaseFunctionsUrl.trim() } }
      : {}),
  },
);
