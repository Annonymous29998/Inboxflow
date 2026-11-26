/**
 * Inbox Flow desktop launcher (Kestrel-style).
 *
 * Starts a local hybrid host, then opens the mailer in an in-app window.
 * Auth / license / bind-status go to Lightsail. Campaigns/contacts/SMTP stay in SQLite.
 * The window loads localhost — never novasreach.xyz. Bind PC is a browser URL from admin.
 * rdp/local: spawn resources/api when present. Bind IP / SOCKS follow send.
 */
const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, ipcMain, powerSaveBlocker } = require('electron');
let sentryMain = null;
try {
  sentryMain = require('@sentry/electron/main');
} catch {
  sentryMain = null;
}
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_REMOTE_URL = 'https://novasreach.xyz';
/** Local browser port — matches Kestrel V1.40 (http://localhost:5000). */
const DEFAULT_LOCAL_PORT = 5000;
const isDev = !app.isPackaged;

let statusWindow = null;
let mailerWindow = null;
let splashWindow = null;
let splashReady = false;
const splashQueue = [];
let tray = null;
let apiChild = null;
let apiFailure = null;
const apiLog = [];
let proxyServer = null;
let shuttingDown = false;
let appUrl = `http://localhost:${DEFAULT_LOCAL_PORT}`;
let sleepBlockerId = null;

const DEFAULT_ELECTRON_DSN =
  'https://1209c769168bfb674074cc0f21bf6e1e@o4512474524352512.ingest.de.sentry.io/4512474541457488';
const ELECTRON_SENTRY_DSN = String(
  process.env.SENTRY_ELECTRON_DSN || process.env.SENTRY_DSN || DEFAULT_ELECTRON_DSN,
).trim();
if (sentryMain && ELECTRON_SENTRY_DSN) {
  sentryMain.init({
    dsn: ELECTRON_SENTRY_DSN,
    environment: app.isPackaged ? 'production' : 'development',
    tracesSampleRate: 0.1,
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function userDataDir() {
  return app.getPath('userData');
}

function appIconFile() {
  const candidates = [
    path.join(__dirname, 'icon.png'),
    path.join(__dirname, '..', 'resources', 'icon.png'),
    path.join(__dirname, '..', 'resources', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.png'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function appIconImage() {
  const file = appIconFile();
  if (!file) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(file);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function setSplash(payload) {
  const next = {
    stage: payload.stage,
    line: payload.line,
    detail: payload.detail,
    hint: payload.hint,
    pct: payload.pct,
  };
  if (splashWindow && !splashWindow.isDestroyed() && splashReady) {
    splashWindow.webContents.send('inboxflow:splash', next);
    return;
  }
  splashQueue.push(next);
}

function envPath() {
  return path.join(userDataDir(), 'inboxflow.env');
}

function configJsonCandidates() {
  const names = ['config.json'];
  const dirs = [
    path.dirname(process.execPath),
    userDataDir(),
    process.resourcesPath || '',
    path.join(__dirname, '..', 'resources'),
  ];
  const out = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) out.push(path.join(dir, name));
  }
  return out;
}

function readLicenseConfigFile() {
  for (const p of configJsonCandidates()) {
    try {
      if (!fs.existsSync(p) || path.basename(p) === 'config.example.json') continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      const username = String(raw.username || raw.user || '').trim();
      const license_key = String(raw.license_key || raw.licenseKey || raw.license || '').trim();
      return { path: p, username, license_key };
    } catch {
      /* try next */
    }
  }
  return null;
}

function ensureConfigJson() {
  const dest = path.join(userDataDir(), 'config.json');
  if (fs.existsSync(dest) || readLicenseConfigFile()) return dest;
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(
    dest,
    `${JSON.stringify({ username: '', license_key: '' }, null, 4)}\n`,
    'utf8',
  );
  return dest;
}

function serveLocalConfigJson(req, res) {
  const urlPath = String(req.url || '').split('?')[0];
  if (req.method !== 'GET' || urlPath !== '/config.json') return false;
  const found = readLicenseConfigFile();
  const body = JSON.stringify(
    found
      ? { username: found.username, license_key: found.license_key }
      : { username: '', license_key: '' },
  );
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
  return true;
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function ensureEnvFile() {
  const dest = envPath();
  if (fs.existsSync(dest)) return dest;

  const exampleCandidates = [
    path.join(process.resourcesPath || '', 'env.desktop.example'),
    path.join(__dirname, '..', 'resources', 'env.desktop.example'),
  ];
  let template = '';
  for (const p of exampleCandidates) {
    if (fs.existsSync(p)) {
      template = fs.readFileSync(p, 'utf8');
      break;
    }
  }
  if (!template) {
    template = `INBOXFLOW_MODE=remote
LOCAL_PORT=${DEFAULT_LOCAL_PORT}
REMOTE_APP_URL=${DEFAULT_REMOTE_URL}
`;
  }

  const filled = template
    .replace(/__JWT_ACCESS__/g, randomSecret())
    .replace(/__JWT_REFRESH__/g, randomSecret())
    .replace(/__ENCRYPTION_KEY__/g, randomSecret())
    .replace(/__WEBHOOK_SECRET__/g, randomSecret(16))
    .replace(/__API_PORT__/g, String(DEFAULT_LOCAL_PORT))
    .replace(/__LOCAL_PORT__/g, String(DEFAULT_LOCAL_PORT))
    .replace(/__REMOTE_APP_URL__/g, DEFAULT_REMOTE_URL);

  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(dest, filled, 'utf8');
  return dest;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Installer ships one archive so setup does not freeze. Expand next to the API, with retries. */
async function ensureApiModules() {
  if (isDev) return;
  const res = process.resourcesPath;
  const dest = path.join(res, 'api', 'node_modules');
  const archive = path.join(res, 'api', 'node_modules.tar');
  const marker = path.join(dest, 'fastify', 'package.json');
  const prismaMarker = path.join(dest, '@prisma', 'client', 'package.json');
  if (fs.existsSync(marker) && fs.existsSync(prismaMarker)) return;
  if (!fs.existsSync(archive)) return;
  const countFile = path.join(res, 'api', 'node_modules.tar.entries');
  const total = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
  const started = Date.now();
  const paintUnpack = (done, force) => {
    const now = Date.now();
    if (!force && now - paintUnpack.last < 200) return;
    paintUnpack.last = now;
    const ratio = total > 0 ? Math.min(1, done / total) : Math.min(0.97, done / 50000);
    const elapsed = Math.max(1, (now - started) / 1000);
    let remain = '';
    if (total > 0 && done > 400) {
      const sec = Math.max(1, Math.round(((total - done) * elapsed) / done));
      remain = sec >= 90 ? ` · about ${Math.ceil(sec / 60)} min left` : ` · about ${sec}s left`;
    }
    const count = total > 0
      ? `${done.toLocaleString()} of ${total.toLocaleString()} files${remain}`
      : `${done.toLocaleString()} files`;
    setSplash({
      stage: 'Setting up Inbox Flow',
      line: 'Copying the mailer onto this PC',
      detail: count,
      hint: 'This happens once. The next open goes straight in.',
      pct: Math.round(10 + ratio * 76),
    });
  };
  paintUnpack.last = 0;
  paintUnpack(0, true);
  await sleep(200);
  fs.mkdirSync(dest, { recursive: true });
  let last = 'unpack failed';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const tar = await import('tar');
      const extract = tar.x || (tar.default && tar.default.x);
      if (!extract) throw new Error('tar extract is unavailable');
      let done = 0;
      await extract({
        file: archive,
        cwd: dest,
        strict: false,
        onentry() {
          done += 1;
          paintUnpack(done, done === total);
          if (done % 200 === 0) return new Promise((resolve) => setImmediate(resolve));
        },
      });
      paintUnpack(total || done, true);
      if (fs.existsSync(marker)) return;
      last = 'fastify missing after unpack';
    } catch (err) {
      if (fs.existsSync(marker)) return;
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(800 * attempt);
  }
  throw new Error(`Could not unpack the mailer. ${last}`);
}

function resolvePaths() {
  if (isDev) {
    const root = path.resolve(__dirname, '../../..');
    return {
      apiEntry: path.join(root, 'apps/api/dist/index.js'),
      apiCwd: path.join(root, 'apps/api'),
      webRoot: path.join(root, 'apps/web/dist'),
      nodeModules: path.join(root, 'node_modules'),
    };
  }
  const res = process.resourcesPath;
  return {
    apiEntry: path.join(res, 'api/dist/index.js'),
    apiCwd: path.join(res, 'api'),
    webRoot: path.join(res, 'web'),
    nodeModules: path.join(res, 'api/node_modules'),
  };
}

function findNodeBinary() {
  const packaged =
    process.platform === 'win32'
      ? path.join(process.resourcesPath || '', 'node', 'node.exe')
      : path.join(process.resourcesPath || '', 'node', 'bin', 'node');
  if (!isDev && fs.existsSync(packaged)) return packaged;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function waitForUrl(url, timeoutMs = 60000) {
  const started = Date.now();
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (shuttingDown) {
        reject(new Error('App shutting down'));
        return;
      }
      if (apiFailure) {
        reject(new Error(apiFailure));
        return;
      }
      const req = lib.get(url, {
        timeout: 4000,
        rejectUnauthorized: String(process.env.INBOXFLOW_TLS_INSECURE || '').toLowerCase() !== '1',
      }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Server not reachable: ${url}`));
        return;
      }
      setTimeout(tick, 800);
    };
    tick();
  });
}

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

function sqliteFileUrl() {
  return `file:${path.join(userDataDir(), 'workspace.db').replace(/\\/g, '/')}`;
}

function isLoopbackPeer(req) {
  const raw = String(req.socket?.remoteAddress || '');
  return raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
}

function isPublicTrackingPath(urlPath) {
  const p = String(urlPath || '').split('?')[0] || '';
  return p.startsWith('/api/t/') || p === '/api/unsubscribe' || p.startsWith('/api/unsubscribe/');
}

function allowInboundTracking(port) {
  if (process.platform !== 'win32') return;
  const name = 'Inbox Flow tracking';
  execFile('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`], { windowsHide: true }, () => {
    execFile(
      'netsh',
      [
        'advfirewall',
        'firewall',
        'add',
        'rule',
        `name=${name}`,
        'dir=in',
        'action=allow',
        'protocol=TCP',
        `localport=${port}`,
        'profile=any',
      ],
      { windowsHide: true },
      () => {},
    );
  });
}

function isCloudLoginPath(urlPath) {
  const p = String(urlPath || '').split('?')[0] || '';
  // Rotation and the physical address are read by the mailer on this PC.
  if (p === '/api/admin/organization') return false;
  return (
    p.startsWith('/api/auth') ||
    p.startsWith('/api/admin') ||
    p.startsWith('/api/workspace/pulse') ||
    p.startsWith('/api/workspace/tracking-mint') ||
    p.startsWith('/api/workspace/tracking-events') ||
    p === '/api/workspace/tracking-host' ||
    p === '/api/admin/health' ||
    p.startsWith('/api/admin/audit')
  );
}

function isRemotePublicHost(url) {
  try {
    const host = new URL(String(url || '')).hostname;
    return (
      /novasreach\.xyz$/i.test(host) ||
      /inboxingsend\.xyz$/i.test(host) ||
      host === '13.38.60.67'
    );
  } catch {
    return false;
  }
}

async function showBindBlockedDialog() {
  try {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Inbox Flow',
      message: 'PC not bound yet',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    });
  } catch {
    /* ignore */
  }
  shuttingDown = true;
  app.quit();
}

function postJson(url, body, timeoutMs = 15000) {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
        rejectUnauthorized: String(process.env.INBOXFLOW_TLS_INSECURE || '').toLowerCase() !== '1',
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = null;
          }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Bind status timed out')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchBindStatus(remoteBase, username, licenseKey) {
  const { status, data } = await postJson(`${remoteBase.replace(/\/$/, '')}/api/auth/bind-status`, {
    username,
    licenseKey,
  });
  if (status === 401) return { ok: false, unauthorized: true };
  if (status >= 500 || !data) throw new Error('Could not check Bind PC status');
  return {
    ok: true,
    staff: Boolean(data.staff),
    bound: Boolean(data.bound),
    boundIp: data.boundIp ? String(data.boundIp) : '',
  };
}

function shouldUseLocalWorkspace(req, hasLocal) {
  if (!hasLocal) return false;
  const p = String(req.url || '').split('?')[0] || '';
  if (isCloudLoginPath(p)) return false;
  return true;
}

function isPlaceholderPublicUrl(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return true;
  if (/your\.rdp\.public\.ip/i.test(v)) return true;
  if (v.includes('13.38.60.67')) return true;
  if (v.includes('localhost') || v.includes('127.0.0.1')) return true;
  return false;
}

function persistBoundIp(ip) {
  const bound = String(ip || '').trim();
  if (!bound) return;
  const dest = envPath();
  const fileEnv = persistMissingSecrets(parseEnvFile(dest));
  const port = Number(fileEnv.LOCAL_PORT || DEFAULT_LOCAL_PORT);
  fileEnv.BOUND_IP = bound;
  fileEnv.PUBLIC_URL = `http://${bound}:${port}`;
  const lines = [];
  if (fs.existsSync(dest)) {
    for (const line of fs.readFileSync(dest, 'utf8').split(/\r?\n/)) {
      if (/^\s*(BOUND_IP|PUBLIC_URL)\s*=/.test(line)) continue;
      lines.push(line);
    }
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  lines.push(`BOUND_IP=${bound}`);
  lines.push(`PUBLIC_URL=${fileEnv.PUBLIC_URL}`);
  fs.writeFileSync(dest, `${lines.join('\n')}\n`, 'utf8');
  const side = path.join(userDataDir(), 'bound-ip');
  fs.writeFileSync(side, `${bound}\n`, 'utf8');
}

function persistMissingSecrets(fileEnv) {
  const dest = envPath();
  const add = [];
  const keys = [
    ['JWT_ACCESS_SECRET', randomSecret()],
    ['JWT_REFRESH_SECRET', randomSecret()],
    ['ENCRYPTION_KEY', randomSecret()],
    ['WEBHOOK_SECRET', randomSecret(16)],
  ];
  for (const [key, val] of keys) {
    if (!fileEnv[key] || String(fileEnv[key]).length < 32) {
      fileEnv[key] = fileEnv[key] && String(fileEnv[key]).length >= 32 ? fileEnv[key] : val;
      add.push(`${key}=${fileEnv[key]}`);
    }
  }
  if (add.length) {
    fs.appendFileSync(dest, `\n${add.join('\n')}\n`, 'utf8');
  }
  return fileEnv;
}

/**
 * Local reverse proxy: login stays on Lightsail; created-user contacts/SMTP
 * stay in SQLite on this PC.
 */
function startRemoteProxy(localPort, remoteBase, localWorkspaceOrigin) {
  const remote = new URL(remoteBase);
  const remoteLib = remote.protocol === 'https:' ? https : http;
  const localWs = localWorkspaceOrigin ? new URL(localWorkspaceOrigin) : null;
  // Reuse TCP connections — without this, every login/API call pays a cold handshake
  // and feels stuck on slow/unstable networks.
  const agent = new remoteLib.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 32,
    maxFreeSockets: 8,
    timeout: 180_000,
  });
  const localAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 32,
  });

  proxyServer = http.createServer((req, res) => {
    // The window uses localhost. The public address only receives opens, clicks, and unsubscribe.
    if (!isLoopbackPeer(req) && !isPublicTrackingPath(req.url || '')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    if (serveLocalConfigJson(req, res)) return;
    const urlPath = req.url || '/';
    const sse = isSsePath(urlPath);
    const heavy = isHeavyApiPath(urlPath);
    const useLocal = shouldUseLocalWorkspace(req, Boolean(localWs));
    const target = useLocal ? localWs : remote;
    const targetLib = useLocal ? http : remoteLib;
    const headers = { ...req.headers, host: target.host };
    // Avoid compressing through proxy edge-cases
    delete headers['accept-encoding'];
    // Let Node manage connection reuse via the keep-alive agent
    delete headers.connection;

    if (sse) {
      headers.accept = headers.accept || 'text/event-stream';
    }

    const opts = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: urlPath,
      method: req.method,
      headers,
      agent: useLocal ? localAgent : agent,
      // Imports / sends need longer; SSE must not idle-timeout mid-stream
      timeout: sse ? 0 : heavy ? 300_000 : 120_000,
      rejectUnauthorized: String(process.env.INBOXFLOW_TLS_INSECURE || '').toLowerCase() !== '1',
    };

    const upstream = targetLib.request(opts, (up) => {
      const outHeaders = { ...up.headers };
      const localOrigin = `http://localhost:${localPort}`;

      // Cookies must bind to localhost, not the Lightsail IP
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

      // Keep the browser on the local port if the API redirects to Lightsail/domain
      if (outHeaders.location) {
        try {
          const loc = new URL(String(outHeaders.location), remoteBase);
          if (
            loc.hostname === remote.hostname ||
            /novasreach\.xyz$/i.test(loc.hostname) ||
            /inboxingsend\.xyz$/i.test(loc.hostname) ||
            loc.hostname === '13.38.60.67'
          ) {
            outHeaders.location = `${localOrigin}${loc.pathname}${loc.search}${loc.hash}`;
          }
        } catch {
          /* leave location as-is */
        }
      }

      if (sse) {
        outHeaders['cache-control'] = 'no-cache, no-transform';
        outHeaders['x-accel-buffering'] = 'no';
        delete outHeaders['content-length'];
      }

      if (!res.headersSent) {
        res.writeHead(up.statusCode || 502, outHeaders);
      }
      up.pipe(res);
      res.on('close', () => {
        try {
          up.destroy();
        } catch {
          /* ignore */
        }
      });
    });

    upstream.on('timeout', () => {
      upstream.destroy(new Error('Upstream timeout'));
    });

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
      res.end(
        `Inbox Flow proxy error: ${err.message}\n\n` +
          `The Lightsail API may be busy or restarting. Wait a few seconds and retry.\n` +
          `Backend: ${remoteBase}`,
      );
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

  proxyServer.requestTimeout = 0;
  proxyServer.headersTimeout = 0;
  proxyServer.keepAliveTimeout = 65_000;

  return new Promise((resolve, reject) => {
    const tryListen = (port, attemptsLeft) => {
      const onError = (err) => {
        proxyServer.removeListener('error', onError);
        if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          const next = port + 1;
          tryListen(next, attemptsLeft - 1);
          return;
        }
        if (err && err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Port ${localPort}–${port} already in use. Quit every Inbox Flow process in Task Manager, then try again.`,
            ),
          );
          return;
        }
        reject(err);
      };
      proxyServer.once('error', onError);
      proxyServer.listen(port, '0.0.0.0', () => {
        proxyServer.removeListener('error', onError);
        allowInboundTracking(port);
        resolve(`http://localhost:${port}`);
      });
    };
    tryListen(localPort, 10);
  });
}

function startLocalApi(fileEnv, opts = {}) {
  const paths = resolvePaths();
  const hybrid = Boolean(opts.hybrid);
  if (!fs.existsSync(paths.apiEntry)) {
    throw new Error(`Local API missing at ${paths.apiEntry}`);
  }
  if (!fs.existsSync(paths.webRoot)) {
    throw new Error(`Local web missing at ${paths.webRoot}`);
  }

  const port = Number(fileEnv.LOCAL_PORT || fileEnv.API_PORT || DEFAULT_LOCAL_PORT);
  const origin = `http://127.0.0.1:${port}`;
  const publishedPort = Number(opts.publishedPort || port);
  const boundIp = String(fileEnv.BOUND_IP || '').trim();
  let publicUrl = String(fileEnv.PUBLIC_URL || fileEnv.TRACKING_BASE_URL || '').replace(/\/$/, '');
  if (boundIp && isPlaceholderPublicUrl(publicUrl)) {
    publicUrl = `http://${boundIp}:${publishedPort}`;
  }
  const browserOrigin = String(opts.browserOrigin || origin);
  const cors = [origin, browserOrigin, publicUrl].filter(Boolean).join(',');
  const childEnv = {
    ...process.env,
    ...fileEnv,
    NODE_ENV: 'production',
    INBOXFLOW_DESKTOP: '1',
    DESKTOP_HYBRID: hybrid ? '1' : '',
    DESKTOP_WEB_ROOT: fs.existsSync(paths.webRoot) ? paths.webRoot : '',
    API_PORT: String(port),
    PORT: String(port),
    APP_URL: browserOrigin,
    API_URL: browserOrigin,
    BOUND_IP: boundIp,
    TRACKING_PORT: String(publishedPort),
    PUBLIC_URL: publicUrl || browserOrigin,
    CORS_ORIGIN: cors || browserOrigin,
    COOKIE_SECURE: 'false',
    REMOTE_APP_URL: String(fileEnv.REMOTE_APP_URL || DEFAULT_REMOTE_URL).replace(/\/$/, ''),
    CLOUD_JWT_ACCESS_SECRET: String(fileEnv.CLOUD_JWT_ACCESS_SECRET || ''),
    WEBHOOK_BASE_URL: publicUrl || browserOrigin,
    RUN_WORKERS: fileEnv.RUN_WORKERS || 'true',
    NODE_PATH: [paths.nodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
  };

  apiFailure = null;
  apiLog.length = 0;
  const logPath = path.join(userDataDir(), 'api-startup.log');
  try {
    fs.writeFileSync(logPath, '');
  } catch {
    /* log file is optional */
  }
  apiChild = spawn(findNodeBinary(), [paths.apiEntry], {
    cwd: paths.apiCwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pushLog = (buf) => {
    const text = String(buf);
    process.stdout.write(`[api] ${text}`);
    try {
      fs.appendFileSync(logPath, text);
    } catch {
      /* ignore */
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      apiLog.push(line);
      if (apiLog.length > 60) apiLog.shift();
    }
  };
  apiChild.stdout?.on('data', pushLog);
  apiChild.stderr?.on('data', pushLog);
  apiChild.on('exit', (code, signal) => {
    apiChild = null;
    if (shuttingDown) return;
    const tail = apiLog.slice(-12).join('\n');
    apiFailure =
      `Local server exited (code ${code ?? 'n/a'}, signal ${signal ?? 'n/a'}).` +
      (tail ? `\n\n${tail}` : '');
  });
  return origin;
}

function hasBoundIpOnDisk() {
  try {
    const fromEnv = String(parseEnvFile(envPath()).BOUND_IP || '').trim();
    if (fromEnv) return true;
    const side = path.join(userDataDir(), 'bound-ip');
    if (fs.existsSync(side) && String(fs.readFileSync(side, 'utf8') || '').trim()) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function browserStartUrl() {
  const base = String(appUrl || '').replace(/\/$/, '');
  return `${base}/login`;
}

function openInBrowser() {
  shell.openExternal(browserStartUrl());
}

function showMailerWindow() {
  if (mailerWindow && !mailerWindow.isDestroyed()) {
    if (mailerWindow.isMinimized()) mailerWindow.restore();
    mailerWindow.show();
    mailerWindow.focus();
    return;
  }
  const icon = appIconImage();
  mailerWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Inbox Flow',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    icon: icon.isEmpty() ? undefined : icon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mailerWindow.setMenuBarVisibility(false);
  mailerWindow.once('ready-to-show', () => {
    if (mailerWindow && !mailerWindow.isDestroyed()) mailerWindow.show();
  });
  mailerWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isRemotePublicHost(url)) return { action: 'deny' };
    try {
      shell.openExternal(url);
    } catch {
      /* ignore */
    }
    return { action: 'deny' };
  });
  mailerWindow.webContents.on('will-navigate', (event, url) => {
    if (isRemotePublicHost(url)) event.preventDefault();
  });
  mailerWindow.loadURL(browserStartUrl());
  mailerWindow.on('closed', () => {
    mailerWindow = null;
  });
}

function createSplashWindow(firstRun) {
  const icon = appIconImage();
  splashWindow = new BrowserWindow({
    width: 560,
    height: 400,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    title: firstRun ? 'Installing Inbox Flow' : 'Starting Inbox Flow',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    icon: icon.isEmpty() ? undefined : icon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.setMenuBarVisibility(false);
  splashWindow.setAlwaysOnTop(true, 'floating');
  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.webContents.on('did-finish-load', () => {
    splashReady = true;
    while (splashQueue.length) {
      splashWindow.webContents.send('inboxflow:splash', splashQueue.shift());
    }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'), {
    query: { first: firstRun ? '1' : '0' },
  });
  splashWindow.on('closed', () => {
    splashWindow = null;
    splashReady = false;
  });
}

function closeSplashSoon() {
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    showMailerWindow();
  }, 1600);
}

function createStatusWindow() {
  const icon = appIconImage();
  statusWindow = new BrowserWindow({
    width: 440,
    height: 280,
    resizable: false,
    maximizable: false,
    title: 'Inbox Flow',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    icon: icon.isEmpty() ? undefined : icon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  body{margin:0;font-family:Segoe UI,Consolas,monospace;background:#0b0f14;color:#d7e0d7;
    display:flex;align-items:center;justify-content:center;height:100vh}
  .box{border:1px solid #1f2a1f;padding:20px 22px;width:360px}
  h1{margin:0 0 8px;font-size:15px;letter-spacing:.08em;color:#7CFF9A;text-transform:uppercase}
  p{margin:6px 0;font-size:12px;line-height:1.45;color:#9bb09b}
  code{color:#e8ffe8}
  .row{display:flex;gap:8px;margin-top:16px}
  button{flex:1;background:#122016;border:1px solid #2a3d2a;color:#d7e0d7;padding:10px;
    cursor:pointer;font:inherit;font-size:12px}
  button.primary{border-color:#7CFF9A;color:#7CFF9A}
  button:hover{background:#183022}
</style></head>
<body>
  <div class="box">
    <h1>Inbox Flow</h1>
    <p>Kestrel-style host — opens in your browser on a <b>local port</b>.</p>
    <p>Browser: <code id="url"></code></p>
    <p>Bind this PC before the mailer.</p>
    <div class="row">
      <button class="primary" id="open">Open in browser</button>
      <button id="quit">Quit</button>
    </div>
  </div>
  <script>
    const u = ${JSON.stringify(browserStartUrl())};
    document.getElementById('url').textContent = u;
    document.getElementById('open').onclick = () => window.inboxflowDesktop.openBrowser();
    document.getElementById('quit').onclick = () => window.inboxflowDesktop.quitApp();
  </script>
</body></html>`;

  statusWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  statusWindow.on('closed', () => {
    statusWindow = null;
  });
}

function createTray() {
  try {
    const img = appIconImage();
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('Inbox Flow');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Inbox Flow', click: () => showMailerWindow() },
        { label: 'Open in browser', click: () => openInBrowser() },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            shuttingDown = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('double-click', () => showMailerWindow());
  } catch {
    /* tray optional */
  }
}

ipcMain.on('inboxflow:open-browser', () => openInBrowser());
ipcMain.on('inboxflow:save-bound-ip', (_evt, ip) => {
  try {
    persistBoundIp(ip);
  } catch (err) {
    console.error('[desktop] save-bound-ip', err);
  }
});
ipcMain.on('inboxflow:bind-blocked', () => {
  void showBindBlockedDialog();
});
ipcMain.on('inboxflow:splash-minimize', () => {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.minimize();
});
ipcMain.on('inboxflow:quit', () => {
  shuttingDown = true;
  app.quit();
});

function stopAll() {
  shuttingDown = true;
  if (proxyServer) {
    try {
      proxyServer.close();
    } catch {
      /* ignore */
    }
    proxyServer = null;
  }
  if (!apiChild) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(apiChild.pid), '/f', '/t'], { windowsHide: true });
    } else {
      apiChild.kill('SIGTERM');
    }
  } catch {
    /* ignore */
  }
  apiChild = null;
}

async function boot() {
  const firstRun = !fs.existsSync(envPath());
  setSplash({
    stage: firstRun ? 'Setting up Inbox Flow' : 'Starting Inbox Flow',
    line: firstRun ? 'Preparing this PC…' : 'Loading your workspace…',
    detail: '',
    hint: 'Inbox Flow opens when ready',
    pct: 4,
  });
  const envFile = ensureEnvFile();
  ensureConfigJson();
  const fileEnv = parseEnvFile(envFile);
  const mode = String(fileEnv.INBOXFLOW_MODE || 'remote').toLowerCase();
  const localSend = mode === 'local' || mode === 'rdp';
  const localPort = Number(fileEnv.LOCAL_PORT || fileEnv.API_PORT || DEFAULT_LOCAL_PORT);
  const remoteBase = String(fileEnv.REMOTE_APP_URL || DEFAULT_REMOTE_URL).replace(/\/$/, '');
  const browserOrigin = `http://localhost:${localPort}`;

  try {
    setSplash({
      line: firstRun ? 'Saving settings on this PC…' : 'Reading settings…',
      detail: '',
      hint: 'Inbox Flow opens when ready',
      pct: 6,
    });
    await ensureApiModules();
    if (localSend) {
      setSplash({ line: 'Starting the mailer…', detail: '', hint: 'Inbox Flow opens when ready', pct: 90 });
      appUrl = startLocalApi(fileEnv);
      setSplash({ line: 'Opening your workspace…', pct: 96 });
      await waitForUrl(`${appUrl}/health`);
    } else {
      persistMissingSecrets(fileEnv);
      const paths = resolvePaths();
      if (!fs.existsSync(paths.apiEntry)) {
        throw new Error(
          `Local API missing at ${paths.apiEntry}. Reinstall Inbox Flow.`,
        );
      }
      const workspacePort = Number(fileEnv.WORKSPACE_API_PORT || 3041);
      setSplash({ line: 'Starting the mailer…', detail: '', hint: 'Inbox Flow opens when ready', pct: 90 });
      startLocalApi(
        {
          ...fileEnv,
          LOCAL_PORT: String(workspacePort),
          API_PORT: String(workspacePort),
          DATABASE_URL: sqliteFileUrl(),
        },
        { hybrid: true, browserOrigin, publishedPort: localPort },
      );
      setSplash({ line: 'Opening your workspace…', pct: 94 });
      await waitForUrl(`http://127.0.0.1:${workspacePort}/health`);
      const workspaceOrigin = `http://127.0.0.1:${workspacePort}`;
      setSplash({ line: 'Preparing the window…', pct: 97 });
      appUrl = await startRemoteProxy(localPort, remoteBase, workspaceOrigin);
      await waitForUrl(`${appUrl}/health`);

      const license = readLicenseConfigFile();
      if (license?.username && license?.license_key) {
        setSplash({ line: 'Checking this PC…', pct: 99 });
        try {
          const status = await fetchBindStatus(remoteBase, license.username, license.license_key);
          if (status.ok && !status.staff && !status.bound) {
            setSplash({ stage: 'PC not bound yet', line: 'PC not bound yet', pct: 100 });
            await showBindBlockedDialog();
            return;
          }
          if (status.ok && status.boundIp) persistBoundIp(status.boundIp);
        } catch {
          /* A failed check must not close a PC that is already bound. The window asks again. */
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setSplash({ stage: 'Could not start', line: message, pct: 100 });
    dialog.showErrorBox(
      'Inbox Flow failed to start',
      `${message}\n\nMode: ${mode}\nConfig: ${envFile}\n` +
        `Expected browser URL: http://localhost:${localPort}\n` +
        (localSend
          ? 'Local/RDP send needs the bundled API + DATABASE_URL on this machine.'
          : 'Tenant mailer is local (SQLite). Auth/license checks use the Inbox Flow API.'),
    );
    app.quit();
    return;
  }

  try {
    if (sleepBlockerId == null || !powerSaveBlocker.isStarted(sleepBlockerId)) {
      sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } catch {
    /* optional on hosts that ignore power blockers */
  }

  createTray();
  setSplash({
    stage: firstRun ? 'Install complete' : 'Ready',
    line: 'Opening Inbox Flow',
    pct: 100,
  });
  closeSplashSoon();
}

if (gotLock) {
  app.on('second-instance', () => {
    try {
      showMailerWindow();
    } catch (err) {
      console.error('[desktop] second instance', err);
    }
  });

  app.whenReady().then(() => {
    try {
      app.setAppUserModelId('io.inboxflow.desktop');
    } catch {
      /* Windows taskbar grouping */
    }
    const firstRun = !fs.existsSync(envPath());
    createSplashWindow(firstRun);
    void boot();
  });
}

app.on('window-all-closed', () => {
  // Keep proxy running (Kestrel-style) until Quit
});

app.on('before-quit', () => {
  stopAll();
});

process.on('uncaughtException', (err) => {
  console.error('[desktop uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[desktop unhandledRejection]', reason);
});
