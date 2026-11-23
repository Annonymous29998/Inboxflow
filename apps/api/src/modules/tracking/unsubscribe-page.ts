function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f4f5f6; color: #1c1c1c; font-family: system-ui, sans-serif; }
  main { max-width: 28rem; padding: 48px 24px; text-align: center; }
  h1 { font-size: 1.6rem; font-weight: 600; margin: 0 0 16px; }
  p { font-size: 1.05rem; line-height: 1.55; margin: 0 0 14px; }
  a { color: #0b57d0; }
  .quiet { color: #5c6570; font-size: 0.95rem; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Shown first. The underlined link is the only control that unsubscribes. */
export function unsubscribeLandingPage(confirmHref: string): string {
  const href = escapeAttr(confirmHref);
  return page(
    'Unsubscribe',
    `<h1>Unsubscribe</h1>
<p>You are about to stop receiving mail from this sender.</p>
<p>If you no longer want these emails, <a href="${href}">unsubscribe from this</a>.</p>
<p class="quiet">You can close this page and keep receiving them.</p>`,
  );
}

export function unsubscribeDonePage(): string {
  return page(
    'You have been unsubscribed',
    `<h1>You have been unsubscribed</h1>
<p>You will no longer receive these emails.</p>`,
  );
}

export function unsubscribeInvalidPage(): string {
  return page(
    'Invalid unsubscribe link',
    `<h1>Invalid unsubscribe link</h1>
<p>This link is missing a valid signature and cannot be used.</p>`,
  );
}

export function unsubscribeConfirmHref(path: string, query: {
  c?: string;
  e?: string;
  cid?: string;
  s?: string;
  o?: string;
}): string {
  const params = new URLSearchParams();
  if (query.o) params.set('o', query.o);
  if (query.c) params.set('c', query.c);
  if (query.e) params.set('e', query.e);
  if (query.cid) params.set('cid', query.cid);
  if (query.s) params.set('s', query.s);
  params.set('confirm', '1');
  return `${path}?${params.toString()}`;
}
