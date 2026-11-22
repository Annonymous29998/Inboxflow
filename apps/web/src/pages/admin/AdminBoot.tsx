import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { ShellHandoff } from '@/components/layout/ShellHandoff';

export function AdminBoot() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), 1400);
    return () => window.clearTimeout(t);
  }, []);

  if (!ready) {
    return <ShellHandoff title="Opening admin interface" lede="Loading admin" />;
  }

  return <AdminLayout />;
}
