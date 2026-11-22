/**
 * Copy staged API node_modules after electron-builder has packed the app.
 * extraResources + signtool race on Windows (EBUSY on zod *.d.cts and Prisma engines).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function robocopy(src, dest) {
  try {
    execFileSync(
      'robocopy',
      [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP', '/R:12', '/W:2'],
      { stdio: 'inherit', windowsHide: true },
    );
  } catch (err) {
    const code = Number(err && err.status);
    // robocopy: 0–7 = success / extra files; 8+ = failure
    if (!Number.isFinite(code) || code >= 8) throw err;
  }
}

function copyRetry(src, dest, attempts = 8) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      fs.cpSync(src, dest, { recursive: true, force: true });
      return;
    } catch (err) {
      last = err;
      const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
      if (!busy || i === attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * i);
    }
  }
  throw last;
}

exports.default = async function afterPack(context) {
  const src = path.join(context.packager.projectDir, '.stage-api-modules');
  if (!fs.existsSync(src)) {
    throw new Error(`afterPack: missing ${src} — run desktop:prepare first`);
  }
  const dest = path.join(context.appOutDir, 'resources', 'api', 'node_modules');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (process.platform === 'win32') {
    robocopy(src, dest);
  } else {
    copyRetry(src, dest);
  }
  if (!fs.existsSync(dest)) {
    throw new Error(`afterPack: failed to copy API node_modules to ${dest}`);
  }
};
