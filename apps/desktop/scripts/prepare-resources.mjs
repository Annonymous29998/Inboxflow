#!/usr/bin/env node
/**
 * Prepare API node_modules + Prisma engines for Electron extraResources.
 * Run after building api + web, before electron-builder.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, '..');
const repoRoot = join(desktopRoot, '../..');
const apiRoot = join(repoRoot, 'apps/api');
const stage = join(desktopRoot, '.stage-api');

function mustExist(p, hint) {
  if (!existsSync(p)) {
    console.error(`Missing ${p}. ${hint || ''}`);
    process.exit(1);
  }
}

mustExist(join(apiRoot, 'dist/index.js'), 'Run: npm run build -w @inboxflow/api');
mustExist(join(repoRoot, 'apps/web/dist/index.html'), 'Run: npm run build -w @inboxflow/web');

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

console.log('Desktop API resources staged at', stage);
console.log('Default Windows EXE is Lightsail-only and does not pack this tree.');
