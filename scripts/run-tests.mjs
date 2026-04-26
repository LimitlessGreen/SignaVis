#!/usr/bin/env node
import { spawn } from 'child_process';

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
const testsGlob = 'tests/*.test.mjs';
const forceEsbuild = process.env.FORCE_ESBUILD === '1' || process.env.FORCE_ESBUILD === 'true';

let args;
if (!forceEsbuild && nodeMajor >= 25) {
  console.log(`node ${process.versions.node}: using --experimental-strip-types`);
  args = ['--experimental-loader', './scripts/ignore-styles-loader.mjs', '--experimental-strip-types', '--test', testsGlob];
} else {
  console.log(`node ${process.versions.node}: using @esbuild-kit/esm-loader fallback`);
  args = ['--experimental-loader', '@esbuild-kit/esm-loader', '--experimental-loader', './scripts/ignore-styles-loader.mjs', '--test', testsGlob];
}

const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code));
child.on('error', (err) => { console.error(err); process.exit(1); });
