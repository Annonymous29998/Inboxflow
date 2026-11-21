/**
 * Inbox Flow desktop launcher (Kestrel-style).
 *
 * Opens http://localhost:LOCAL_PORT in your browser (same as Kestrel V1.40).
 * Default: local port proxies to Lightsail — same login, DB, campaigns, SMTP.
 * Bind IP / SOCKS follow the send process: remote = Lightsail, local = this PC.
 */
const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_REMOTE_URL = 'https://novasreach.xyz';
/** Local browser port — matches Kestrel V1.40 (http://localhost:5000). */
const DEFAULT_LOCAL_PORT = 5000;
const isDev = !app.isPackaged;

let statusWindow = null;
let splashWindow = null;
let splashReady = false;
const splashQueue = [];
let tray = null;
let apiChild = null;
let proxyServer = null;
let shuttingDown = false;
let appUrl = `http://localhost:${DEFAULT_LOCAL_PORT}`;
let sleepBlockerId = null;

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

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function jwtFromRequest(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)access_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function isCloudLoginPath(urlPath) {
  const p = String(urlPath || '').split('?')[0] || '';
  return (
    p.startsWith('/api/auth') ||
    p.startsWith('/api/admin') ||
    p.startsWith('/api/workspace/pulse') ||
    p === '/api/admin/health' ||
    p.startsWith('/api/admin/audit')
  );
}

function shouldUseLocalWorkspace(req, hasLocal) {
  if (!hasLocal) return false;
  const p = String(req.url || '').split('?')[0] || '';
  if (!p.startsWith('/api/')) return false;
  // Gmail has no JWT — opens/clicks must still hit this VPS, not Lightsail.
  if (p.startsWith('/api/t/') || p.startsWith('/api/unsubscribe')) return true;
  if (isCloudLoginPath(p)) return false;
  const payload = decodeJwtPayload(jwtFromRequest(req));
  const role = payload && payload.role;
  if (payload && payload.workspaceLocal === true) return true;
  if (!role || role === 'SUPER_ADMIN') return false;
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
      proxyServer.listen(port, '127.0.0.1', () => {
        proxyServer.removeListener('error', onError);
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
  if (!hybrid && !fs.existsSync(paths.webRoot)) {
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
    INBOXFLOW_DESKTOP: hybrid ? '' : '1',
    DESKTOP_HYBRID: hybrid ? '1' : '',
    DESKTOP_WEB_ROOT: hybrid ? '' : paths.webRoot,
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

  apiChild = spawn(findNodeBinary(), [paths.apiEntry], {
    cwd: paths.apiCwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  apiChild.stdout?.on('data', (buf) => process.stdout.write(`[api] ${buf}`));
  apiChild.stderr?.on('data', (buf) => process.stderr.write(`[api] ${buf}`));
  apiChild.on('exit', (code, signal) => {
    apiChild = null;
    if (!shuttingDown) {
      dialog.showErrorBox(
        'Inbox Flow API stopped',
        `Local server exited (code ${code ?? 'n/a'}, signal ${signal ?? 'n/a'}).`,
      );
    }
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

function createSplashWindow(firstRun) {
  const icon = appIconImage();
  splashWindow = new BrowserWindow({
    width: 520,
    height: 340,
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
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.show();
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
        { label: `Open ${browserStartUrl()}`, click: () => openInBrowser() },
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
    tray.on('double-click', () => openInBrowser());
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
    stage: firstRun ? 'Installing Inbox Flow' : 'Starting Inbox Flow',
    line: firstRun ? 'Preparing this PC…' : 'Loading workspace…',
    pct: 8,
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
      line: firstRun ? 'Writing local config…' : 'Reading local config…',
      pct: 22,
    });
    if (localSend) {
      setSplash({ line: 'Starting local host…', pct: 45 });
      appUrl = startLocalApi(fileEnv);
      setSplash({ line: `Waiting for http://localhost:${localPort}…`, pct: 70 });
      await waitForUrl(`${appUrl}/health`);
    } else {
      persistMissingSecrets(fileEnv);
      const workspacePort = Number(fileEnv.WORKSPACE_API_PORT || 3041);
      setSplash({ line: 'Starting local host…', pct: 40 });
      startLocalApi(
        {
          ...fileEnv,
          LOCAL_PORT: String(workspacePort),
          API_PORT: String(workspacePort),
          DATABASE_URL: sqliteFileUrl(),
        },
        { hybrid: true, browserOrigin, publishedPort: localPort },
      );
      setSplash({ line: 'Connecting workspace…', pct: 58 });
      await waitForUrl(`http://127.0.0.1:${workspacePort}/health`);
      setSplash({ line: 'Connecting Inbox Flow…', pct: 72 });
      await waitForUrl(`${remoteBase}/health`);
      setSplash({ line: `Binding http://localhost:${localPort}…`, pct: 84 });
      appUrl = await startRemoteProxy(localPort, remoteBase, `http://127.0.0.1:${workspacePort}`);
      await waitForUrl(`${appUrl}/health`);
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
          : `Remote backend: ${remoteBase}`),
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
  createStatusWindow();
  setSplash({
    stage: firstRun ? 'Install complete' : 'Ready',
    line: `Opening ${browserStartUrl()}`,
    pct: 100,
  });
  openInBrowser();
  closeSplashSoon();
}

if (gotLock) {
  app.on('second-instance', () => {
    try {
      if (statusWindow) {
        if (statusWindow.isMinimized()) statusWindow.restore();
        statusWindow.show();
        statusWindow.focus();
      }
      openInBrowser();
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
