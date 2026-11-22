/**
 * Pack API node_modules as one tar after electron-builder finishes.
 * A loose tree makes NSIS look frozen. Windows tar.exe also fails on long paths,
 * so this uses the Node tar package (PAX headers).
 */
const fs = require('fs');
const path = require('path');
const tar = require('tar');

exports.default = async function afterPack(context) {
  const src = path.join(context.packager.projectDir, '.stage-api-modules');
  if (!fs.existsSync(src)) {
    throw new Error(`afterPack: missing ${src} — run desktop:prepare first`);
  }
  const dest = path.join(context.appOutDir, 'resources', 'api', 'node_modules.tar');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  await tar.c(
    {
      file: dest,
      cwd: src,
      portable: true,
      noMtime: true,
    },
    ['.'],
  );
  const loose = path.join(context.appOutDir, 'resources', 'api', 'node_modules');
  if (fs.existsSync(loose)) fs.rmSync(loose, { recursive: true, force: true });
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024 * 1024) {
    throw new Error(`afterPack: node_modules.tar missing or too small at ${dest}`);
  }
};
