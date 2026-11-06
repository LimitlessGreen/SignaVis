#!/usr/bin/env node
// Packs SignaVis Lite as an MSIX for the Microsoft Store (unsigned — the Store signs it).
//
//   node scripts/lite-msix.mjs <signavis-lite.exe> [--out=dir] [--layout-only]
//
// Build the exe first with the Store feature (no self-updater):
//   cd src-tauri-lite && npx tauri build --no-bundle --features store
//
// --layout-only: only write the package folder (for a local test with
//   Add-AppxPackage -Register <out>/layout/AppxManifest.xml, needs developer mode).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const exe = args.find((a) => !a.startsWith('--'));
const out = path.resolve(args.find((a) => a.startsWith('--out='))?.slice(6) ?? path.join(ROOT, 'src-tauri-lite', 'target-msix'));
const layoutOnly = args.includes('--layout-only');
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: lite-msix.mjs <signavis-lite.exe> [--out=dir] [--layout-only]');
  process.exit(1);
}

// Store versions are a.b.c.0; a pre-release maps to its base version.
const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const base = version.split('-')[0];
if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error(`unexpected VERSION: ${version}`);
const msixVersion = `${base}.0`;

const layout = path.join(out, 'layout');
fs.rmSync(layout, { recursive: true, force: true });
fs.mkdirSync(path.join(layout, 'Assets'), { recursive: true });
fs.copyFileSync(exe, path.join(layout, 'signavis-lite.exe'));
for (const icon of ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png']) {
  fs.copyFileSync(path.join(ROOT, 'src-tauri-lite', 'icons', icon), path.join(layout, 'Assets', icon));
}
const manifest = fs.readFileSync(path.join(ROOT, 'src-tauri-lite', 'msix', 'AppxManifest.xml'), 'utf8')
  .replaceAll('{{VERSION}}', msixVersion);
fs.writeFileSync(path.join(layout, 'AppxManifest.xml'), manifest);
console.log(`layout: ${layout} (version ${msixVersion})`);
if (layoutOnly) process.exit(0);

// makeappx from the newest Windows SDK.
function findMakeAppx() {
  if (process.env.MAKEAPPX) return process.env.MAKEAPPX;
  const kits = 'C:/Program Files (x86)/Windows Kits/10/bin';
  const sdks = fs.readdirSync(kits).filter((d) => /^10\./.test(d))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
  for (const sdk of sdks) {
    const p = path.join(kits, sdk, 'x64', 'makeappx.exe');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('makeappx.exe not found (install the Windows SDK or set MAKEAPPX)');
}
const msix = path.join(out, `SignaVis-Lite_${msixVersion}_x64.msix`);
execFileSync(findMakeAppx(), ['pack', '/o', '/d', layout, '/p', msix], { stdio: 'inherit' });
console.log(`msix: ${msix}`);
