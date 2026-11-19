#!/usr/bin/env node
/**
 * Download portable Node.js for Windows into resources/node
 * so the packaged EXE does not require a system Node install.
 *
 * Usage: node apps/desktop/scripts/download-node-win.mjs
 */
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = process.env.NODE_WIN_VERSION || 'v20.18.1';
const url = `https://nodejs.org/dist/${VERSION}/node-${VERSION}-win-x64.zip`;
const outDir = join(__dirname, '..', 'resources', 'node');
const cacheDir = join(__dirname, '..', '.cache');
const zipPath = join(cacheDir, `node-${VERSION}-win-x64.zip`);
const extractRoot = join(cacheDir, 'node-extract');

mkdirSync(cacheDir, { recursive: true });

if (existsSync(join(outDir, 'node.exe'))) {
  console.log('Already have', join(outDir, 'node.exe'));
  process.exit(0);
}

console.log('Downloading', url);
execSync(`curl -L --retry 5 --retry-delay 3 -o "${zipPath}" "${url}"`, { stdio: 'inherit' });

rmSync(outDir, { recursive: true, force: true });
rmSync(extractRoot, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(extractRoot, { recursive: true });

execSync(`unzip -qo "${zipPath}" -d "${extractRoot}"`, { stdio: 'inherit' });
const nested = join(extractRoot, `node-${VERSION}-win-x64`);
execSync(`cp -R "${nested}/." "${outDir}/"`, { stdio: 'inherit' });

if (!existsSync(join(outDir, 'node.exe'))) {
  console.error('node.exe missing after extract');
  process.exit(1);
}
console.log('Portable Node ready at', join(outDir, 'node.exe'));
