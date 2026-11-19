#!/usr/bin/env node
/**
 * Checks the Windows installer is a thin Lightsail client (fast extract)
 * and that the packaged app contains the launcher + env template.
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

if (setupMb > 120) {
  fail(`installer is ${setupMb.toFixed(1)} MB — still packing API/node (should be under ~100 MB)`);
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

if (existsSync(join(resources, 'api', 'node_modules'))) {
  fail('api/node_modules is packed — install will be slow again');
}
if (existsSync(join(resources, 'node', 'node.exe'))) {
  fail('portable node.exe is packed — install will be slow again');
}
ok('no API node_modules / portable Node in package');

const unpackedMb = Number(
  execSync(`du -sm "${unpacked}" | awk '{print $1}'`, { encoding: 'utf8' }).trim(),
);
ok(`win-unpacked ${unpackedMb} MB`);
if (unpackedMb > 350) {
  fail(`unpacked tree is ${unpackedMb} MB — extract will stall on Windows`);
}

const listing = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
if (!listing.includes('InboxFlow.exe')) fail('zip does not contain InboxFlow.exe');
if (listing.includes('api/node_modules') || listing.includes('node/node.exe')) {
  fail('zip still contains API/node payload');
}
ok('zip listing contains InboxFlow.exe only (thin client)');

console.log('\nInstaller package looks complete and thin. NSIS silent-run needs Windows;');
console.log('this Mac cannot execute the setup EXE (no Wine).');
process.exit(0);
