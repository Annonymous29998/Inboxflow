/**
 * Vercel only ships the web SPA. Skip the Electron workspace so npm does not
 * download Electron / @sentry/electron binaries (that is what broke the last
 * two Production deploys).
 */
import { readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.workspaces = ['apps/web', 'apps/api'];
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const env = {
  ...process.env,
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  npm_config_ignore_scripts: 'true',
};
const result = spawnSync('npm', ['install', '--include=dev', '--ignore-scripts'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
