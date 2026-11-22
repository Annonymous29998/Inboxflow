import '@/styles/admin-web.css';

export function ShellHandoff({ title, lede }: { title: string; lede: string }) {
  return (
    <div className="if-admin-root relative flex h-dvh items-center justify-center overflow-hidden">
      <div className="relative z-10 space-y-4 px-6 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#3dff3d] text-sm font-extrabold text-[#050805] shadow-[0_8px_20px_rgba(61,255,61,0.28)]">
          IF
        </div>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-700">Inbox Flow</p>
        <p className="if-admin-heading text-3xl font-semibold">{title}</p>
        <p className="if-admin-lede text-sm">{lede}</p>
        <div className="mx-auto h-1 w-44 overflow-hidden rounded-full bg-slate-300">
          <div className="if-admin-boot-bar h-full bg-teal-600" />
        </div>
      </div>
    </div>
  );
}
