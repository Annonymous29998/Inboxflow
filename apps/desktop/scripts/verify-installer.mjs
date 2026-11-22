#!/usr/bin/env node
/**
 * Checks the Windows installer packs the hybrid mailer (local API + web + Node)
 * plus launcher + env template.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, '..');
const releaseDir = join(desktopRoot, 'release');
const unpacked = join(releaseDir, 'win-unpacked');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`OK   ${msg}`);
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}

function zipListing(zipPath) {
  try {
    return execSync(`tar -tf "${zipPath}"`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    return execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  }
}

if (!existsSync(releaseDir)) fail('release/ missing — run npm run dist:win first');

const files = readdirSync(releaseDir);
const versionKey = (name) => {
  const m = name.match(/InboxFlow-Setup-(\d+)\.(\d+)\.(\d+)\.(exe|zip)$/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const newest = (ext) =>
  files
    .filter((f) => new RegExp(`^InboxFlow-Setup-\\d+\\.\\d+\\.\\d+\\.${ext}$`).test(f))
    .sort((a, b) => {
      const av = versionKey(a);
      const bv = versionKey(b);
      return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
    })
    .at(-1);
const setup = newest('exe');
const zip = newest('zip');
if (!setup) fail('InboxFlow-Setup-*.exe not found in release/');
if (!zip) fail('InboxFlow-Setup-*.zip not found in release/');

const setupPath = join(releaseDir, setup);
const zipPath = join(releaseDir, zip);
const setupMb = statSync(setupPath).size / (1024 * 1024);
const zipMb = statSync(zipPath).size / (1024 * 1024);

ok(`${setup}  ${setupMb.toFixed(1)} MB`);
ok(`${zip}  ${zipMb.toFixed(1)} MB`);

if (setupMb > 280) {
  fail(`installer is ${setupMb.toFixed(1)} MB — larger than the hybrid package budget`);
}
if (setupMb < 40) {
  fail(`installer is ${setupMb.toFixed(1)} MB — suspiciously small`);
}

if (!existsSync(unpacked)) fail('win-unpacked/ missing');
const exe = join(unpacked, 'InboxFlow.exe');
if (!existsSync(exe)) fail('win-unpacked/InboxFlow.exe missing');
ok('InboxFlow.exe present in unpacked dir');

const resources = join(unpacked, 'resources');
if (!existsSync(join(resources, 'env.desktop.example'))) {
  fail('resources/env.desktop.example missing');
}
ok('env.desktop.example packed');

if (!existsSync(join(unpacked, 'config.json'))) {
  fail('win-unpacked/config.json missing — zip must ship config.json next to InboxFlow.exe');
}
ok('config.json packed next to InboxFlow.exe');

if (!existsSync(join(resources, 'api', 'dist', 'index.js'))) {
  fail('resources/api/dist/index.js missing — hybrid mailer needs the bundled API');
}
ok('bundled API packed');

if (!existsSync(join(resources, 'api', 'node_modules'))) {
  fail('resources/api/node_modules missing — local API cannot start');
}
ok('API node_modules packed');

if (!existsSync(join(resources, 'web', 'index.html'))) {
  fail('resources/web/index.html missing — in-app window needs the local mailer UI');
}
ok('local web UI packed');

if (!existsSync(join(resources, 'node', 'node.exe'))) {
  fail('resources/node/node.exe missing — packaged API needs portable Node');
}
ok('portable Node packed');

const unpackedMb = dirSizeBytes(unpacked) / (1024 * 1024);
ok(`win-unpacked ${unpackedMb.toFixed(1)} MB`);
if (unpackedMb > 950) {
  fail(`unpacked tree is ${unpackedMb.toFixed(1)} MB — extract will stall on Windows`);
}

const listing = zipListing(zipPath);
if (!listing.includes('InboxFlow.exe')) fail('zip does not contain InboxFlow.exe');
if (!/\bconfig\.json\b/.test(listing)) fail('zip does not contain config.json');
if (!listing.includes('api/dist/index.js') && !listing.includes('api\\dist\\index.js')) {
  fail('zip does not contain the bundled API');
}
ok('zip listing contains InboxFlow.exe + hybrid API');

console.log('\nInstaller package looks complete (hybrid local mailer).');
process.exit(0);
