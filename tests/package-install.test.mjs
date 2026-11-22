// Installing the published package must not run a script that is not in the
// package (1.3.2 had postinstall → scripts/postinstall.js, not in "files", so
// `npm i signavis` failed for every user).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('no install script runs on a consumer install unless it ships with the package', () => {
    const shipped = (rel) => pkg.files.some((f) => rel === f || rel.startsWith(f.endsWith('/') ? f : `${f}/`));
    const bad = [];
    for (const hook of ['preinstall', 'install', 'postinstall']) {
        const cmd = pkg.scripts?.[hook];
        if (!cmd) continue;
        for (const m of cmd.matchAll(/(?:^|\s)(?:node|bash|sh)\s+(\.\/)?([^\s]+)/g)) {
            if (!shipped(m[2])) bad.push(`${hook}: ${m[2]} is not in "files"`);
        }
    }
    assert.deepEqual(bad, []);
});
