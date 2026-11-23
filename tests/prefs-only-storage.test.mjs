// Small persisted settings go through src/infrastructure/storage/prefs.ts, so
// blocked storage never throws and an embedding host can swap the backend in one place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../src');
const ALLOWED = new Set(['infrastructure/storage']);

function* files(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'pkg') yield* files(p); }
        else if (/\.(ts|js|mjs)$/.test(e.name)) yield p;
    }
}

test('no direct localStorage access outside infrastructure/storage', () => {
    const hits = [];
    for (const f of files(SRC)) {
        const rel = path.relative(SRC, f).split(path.sep).join('/');
        if ([...ALLOWED].some((a) => rel.startsWith(a + '/'))) continue;
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
            if (/\blocalStorage\s*[.?[]/.test(code) || /\.localStorage\b/.test(code)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(hits, [], `use prefs from infrastructure/storage/prefs.ts:\n${hits.join('\n')}`);
});
