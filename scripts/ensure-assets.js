#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TAXONOMY_FILE = path.join(ROOT, 'demo', 'data', 'birdnet-taxonomy.v2.4.json');
const UPSTREAM_LABELS = path.join(ROOT, '_birdnet_upstream', 'birdnet_analyzer', 'labels', 'V2.4');

function main() {
    if (fs.existsSync(TAXONOMY_FILE)) {
        console.log('[ensure-assets] Taxonomy file found.');
        return;
    }

    console.warn('[ensure-assets] Taxonomy file NOT found.');

    if (fs.existsSync(UPSTREAM_LABELS)) {
        console.log('[ensure-assets] Found local labels upstream. Building taxonomy...');
        const res = spawnSync('node', [
            './scripts/build-birdnet-taxonomy.js',
            '--source', './_birdnet_upstream/birdnet_analyzer/labels/V2.4',
            '--output', './demo/data/birdnet-taxonomy.v2.4.json',
            '--model', 'V2.4'
        ], { stdio: 'inherit', cwd: ROOT });

        if (res.status !== 0) {
            console.error('[ensure-assets] Taxonomy build failed.');
            process.exit(1);
        }
    } else {
        console.warn('\n[ensure-assets] ⚠️  REQUIRED ASSETS MISSING');
        console.warn('The species database and images are missing and required for the labeling app.');
        console.warn('To build them locally, run:');
        console.warn('\n  git clone --depth 1 https://github.com/birdnet-team/BirdNET-Analyzer.git _birdnet_upstream');
        console.warn('  npm run taxonomy:build\n');

        // We don't exit with error here to allow vite to start, but the app will show a warning.
    }
}

main();
