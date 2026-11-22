#!/usr/bin/env node
/**
 * Prepare API node_modules + Prisma engines + web dist for Electron extraResources.
 * Run after building api + web, before electron-builder.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, '..');
const repoRoot = join(desktopRoot, '../..');
const apiRoot = join(repoRoot, 'apps/api');
const stage = join(desktopRoot, '.stage-api');
const webDist = join(repoRoot, 'apps/web/dist');

function mustExist(p, hint) {
  if (!existsSync(p)) {
    console.error(`Missing ${p}. ${hint || ''}`);
    process.exit(1);
  }
}

function pruneTypeFiles(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      pruneTypeFiles(p);
      continue;
    }
    if (/\.(d\.ts|d\.cts|d\.mts|map)$/i.test(ent.name)) rmSync(p);
  }
}

mustExist(join(apiRoot, 'dist/index.js'), 'Run: npm run build -w @inboxflow/api');
mustExist(join(webDist, 'index.html'), 'Run: npm run build -w @inboxflow/web');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(apiRoot, 'dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(apiRoot, 'prisma'), join(stage, 'prisma'), { recursive: true });
cpSync(join(apiRoot, 'package.json'), join(stage, 'package.json'));

console.log('Installing production API dependencies into staging…');
execSync('npm install --omit=dev --ignore-scripts', {
  cwd: stage,
  stdio: 'inherit',
  env: { ...process.env, npm_config_production: 'true' },
});
mustExist(
  join(stage, 'node_modules'),
  'npm install --omit=dev did not create .stage-api/node_modules',
);

console.log('Generating Prisma clients for staged API…');
execSync('npx prisma generate', {
  cwd: stage,
  stdio: 'inherit',
});
execSync('npx prisma generate --schema prisma/schema.sqlite.prisma', {
  cwd: stage,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: 'file:./workspace.db' },
});
const sqliteGen = join(stage, 'src/generated');
if (existsSync(sqliteGen)) {
  cpSync(sqliteGen, join(stage, 'dist/generated'), { recursive: true });
}

// electron-builder skips gitignored node_modules/; copy under a different name.
const vendor = join(desktopRoot, '.stage-api-modules');
const stagedMods = join(stage, 'node_modules');
mustExist(stagedMods, 'npm install in .stage-api did not create node_modules');
rmSync(vendor, { recursive: true, force: true });
cpSync(stagedMods, vendor, { recursive: true });
pruneTypeFiles(vendor);
rmSync(stagedMods, { recursive: true, force: true });

console.log('Desktop API resources staged at', stage);
console.log('API node_modules staged at', vendor);
console.log('Web dist ready at', webDist);
