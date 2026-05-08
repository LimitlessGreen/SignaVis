#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const required = process.argv.includes('--required');
const scriptPath = './scripts/setup-git-hooks.sh';

const bashCheck = spawnSync('bash', ['--version'], { stdio: 'ignore' });
if (bashCheck.status !== 0) {
    const msg = '[signavis] Skipping git hook setup: bash not found.';
    if (required) {
        console.error(msg);
        process.exit(1);
    }
    console.log(msg);
    process.exit(0);
}

const result = spawnSync('bash', [scriptPath], { stdio: 'inherit' });
if (result.status !== 0 && required) process.exit(result.status || 1);
process.exit(0);
