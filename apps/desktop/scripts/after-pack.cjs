/**
 * Pack API node_modules as one zip after electron-builder finishes.
 * A loose node_modules tree makes NSIS look frozen (tens of thousands of files).
 * The EXE extracts the zip on first launch.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const src = path.join(context.packager.projectDir, '.stage-api-modules');
  if (!fs.existsSync(src)) {
    throw new Error(`afterPack: missing ${src} — run desktop:prepare first`);
  }
  const dest = path.join(context.appOutDir, 'resources', 'api', 'node_modules.tar');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  // One uncompressed archive. NSIS then copies a single file instead of tens of thousands.
  execFileSync('tar', ['-cf', dest, '-C', src, '.'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  const loose = path.join(context.appOutDir, 'resources', 'api', 'node_modules');
  if (fs.existsSync(loose)) fs.rmSync(loose, { recursive: true, force: true });
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024 * 1024) {
    throw new Error(`afterPack: node_modules.tar missing or too small at ${dest}`);
  }
};
