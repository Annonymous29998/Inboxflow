/**
 * Vercel only ships the Vite SPA. The repo is a workspace that also contains
 * the API (Prisma) and Electron desktop app; installing those on Vercel is
 * what has been failing Production since Sentry was added.
 *
 * Narrow workspaces to apps/web and install without the monorepo lockfile so
 * npm does not error on a workspace mismatch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.workspaces = ['apps/web'];
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const result = spawnSync(
  'npm',
  ['install', '--include=dev', '--no-package-lock', '--no-audit', '--no-fund'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    },
    shell: process.platform === 'win32',
  },
);
process.exit(result.status ?? 1);
