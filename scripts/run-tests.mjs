#!/usr/bin/env node
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const defaultGlob = 'tests/*.test.mjs';
const forceEsbuild = process.env.FORCE_ESBUILD === '1' || process.env.FORCE_ESBUILD === 'true';

// Find test files inside `tests/` and return an explicit list of file paths.
function collectTestFiles(dir) {
  const out = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && /\.test\.(mjs|js|ts)$/.test(e.name)) out.push(p);
      else if (e.isDirectory()) out.push(...collectTestFiles(p));
    }
  } catch (e) {
    return [];
  }
  return out;
}

let testTargets = [defaultGlob];
const testsDir = path.join(process.cwd(), 'tests');
const found = collectTestFiles(testsDir);
if (found.length > 0) {
  // Use explicit file paths to avoid directory imports being resolved by loaders
  testTargets = found.map((p) => path.relative(process.cwd(), p));
}

let args;
if (!forceEsbuild && nodeMajor >= 25) {
  console.log(`node ${process.versions.node}: using --experimental-strip-types`);
  args = ['--experimental-loader', './scripts/ignore-styles-loader.mjs', '--experimental-strip-types', '--test', ...testTargets];
} else {
  console.log(`node ${process.versions.node}: using tsx loader fallback`);
  args = ['--experimental-loader', 'tsx/esm', '--experimental-loader', './scripts/ignore-styles-loader.mjs', '--test', ...testTargets];
}

const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code));
child.on('error', (err) => { console.error(err); process.exit(1); });
