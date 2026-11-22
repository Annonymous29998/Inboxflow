/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_BIND_PC_URL?: string;
  readonly VITE_USE_EDGE_FUNCTIONS?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_FUNCTIONS_URL?: string;
  readonly VITE_SENTRY_DSN?: string;
}

interface InboxflowDesktopBridge {
  isDesktop?: boolean;
  platform?: string;
  saveBoundIp?: (ip: string) => void;
}

interface Window {
  inboxflowDesktop?: InboxflowDesktopBridge;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
