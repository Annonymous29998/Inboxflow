/**
 * Same as the Windows EXE: http://localhost:5000 → Lightsail Inbox Flow.
 * Use this on the Mac to see live campaigns while designing features.
 */
import http from 'http';
import https from 'https';

const LOCAL_PORT = Number(process.env.LOCAL_PORT || 5000);
const REMOTE_BASE = process.env.REMOTE_APP_URL || 'https://novasreach.xyz';

const remote = new URL(REMOTE_BASE);
const remoteLib = remote.protocol === 'https:' ? https : http;
const rejectUnauthorized = String(process.env.INBOXFLOW_TLS_INSECURE || '').toLowerCase() !== '1';
const agent = new remoteLib.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 180_000,
});

function isSsePath(urlPath) {
  const p = String(urlPath || '').split('?')[0] || '';
  return /\/stream$/i.test(p) || /\/send-status\/stream$/i.test(p);
}

function isHeavyApiPath(urlPath) {
  const p = String(urlPath || '').split('?')[0] || '';
  return (
    /\/api\/contacts\/import$/i.test(p) ||
    /\/api\/import\//i.test(p) ||
    /\/api\/campaigns\/[^/]+\/(send|resend|prepare-send|send-one)/i.test(p)
  );
}

const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';
  const sse = isSsePath(urlPath);
  const heavy = isHeavyApiPath(urlPath);
  const headers = { ...req.headers, host: remote.host };
  delete headers['accept-encoding'];
  delete headers.connection;
  if (sse) headers.accept = headers.accept || 'text/event-stream';

  const upstream = remoteLib.request(
    {
      protocol: remote.protocol,
      hostname: remote.hostname,
      port: remote.port || (remote.protocol === 'https:' ? 443 : 80),
      path: urlPath,
      method: req.method,
      headers,
      agent,
      timeout: sse ? 0 : heavy ? 300_000 : 120_000,
      rejectUnauthorized,
    },
    (up) => {
      const outHeaders = { ...up.headers };
      const localOrigin = `http://localhost:${LOCAL_PORT}`;
      if (outHeaders['set-cookie']) {
        const cookies = Array.isArray(outHeaders['set-cookie'])
          ? outHeaders['set-cookie']
          : [outHeaders['set-cookie']];
        outHeaders['set-cookie'] = cookies.map((c) =>
          String(c)
            .replace(/;\s*Domain=[^;]*/gi, '')
            .replace(/;\s*Secure/gi, '')
            .replace(/;\s*SameSite=None/gi, '; SameSite=Lax'),
        );
      }
      if (outHeaders.location) {
        try {
          const loc = new URL(String(outHeaders.location), REMOTE_BASE);
          if (loc.hostname === remote.hostname || loc.hostname === '13.38.60.67') {
            outHeaders.location = `${localOrigin}${loc.pathname}${loc.search}${loc.hash}`;
          }
        } catch {
          /* keep location */
        }
      }
      if (sse) {
        outHeaders['cache-control'] = 'no-cache, no-transform';
        outHeaders['x-accel-buffering'] = 'no';
        delete outHeaders['content-length'];
      }
      if (!res.headersSent) res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res);
      res.on('close', () => {
        try {
          up.destroy();
        } catch {
          /* ignore */
        }
      });
    },
  );

  upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', (err) => {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Inbox Flow proxy error: ${err.message}\nBackend: ${REMOTE_BASE}\n`);
  });
  req.on('aborted', () => {
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  });
  req.pipe(upstream);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;

server.listen(LOCAL_PORT, '127.0.0.1', () => {
  console.log(`Inbox Flow live UI: http://localhost:${LOCAL_PORT}  →  ${REMOTE_BASE}`);
});
