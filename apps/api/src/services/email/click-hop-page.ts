function esc(s: string) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function hostOf(url: string) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

export function clickHopPageHtml(opts: {
  destUrl: string;
  continueUrl: string;
  autoMs?: number;
  preview?: boolean;
}) {
  const dest = opts.destUrl;
  const go = opts.continueUrl;
  const ms = Number.isFinite(opts.autoMs) ? Math.max(800, Number(opts.autoMs)) : 2800;
  const label = hostOf(dest);
  const note = opts.preview
    ? 'Preview only — this sample does not leave Inbox Flow.'
    : 'Signed hop. Tampered or unsigned links are blocked.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Inbox Flow</title>
${opts.preview ? '' : `<meta http-equiv="refresh" content="${Math.ceil(ms / 1000)};url=${esc(go)}">`}
<style>
  html,body{margin:0;height:100%;background:#070c07;color:#c8e6c8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:min(440px,100%);border:1px solid #1f3d1f;background:#0b120b;padding:28px}
  .brand{color:#3dff3d;letter-spacing:.18em;font-size:11px}
  h1{font-size:18px;font-weight:600;margin:14px 0 8px;color:#e8ffe8}
  .host{color:#7dd3c0;word-break:break-all;font-size:13px;line-height:1.45}
  .btn{display:inline-block;margin-top:22px;background:#3dff3d;color:#050805;text-decoration:none;padding:10px 16px;font-weight:700;letter-spacing:.04em}
  .hint{margin-top:16px;font-size:11px;color:#6b8f6b;line-height:1.45}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="brand">INBOX FLOW</div>
  <h1>${opts.preview ? 'Click hop preview' : 'Continue to this site'}</h1>
  <p class="host">${esc(label)}</p>
  <a class="btn" href="${esc(go)}">${opts.preview ? 'Sample continue' : 'Continue'}</a>
  <p class="hint">${esc(note)}</p>
</div></div>
${opts.preview ? '' : `<script>setTimeout(function(){location.replace(${JSON.stringify(go)});},${ms});</script>`}
</body>
</html>`;
}
