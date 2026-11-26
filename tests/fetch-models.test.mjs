// Every model folder the app loads from models/ must be fetched by scripts/fetch-models.mjs,
// which Pages CI runs before the build; a folder missing there is a 404 on the web app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODELS, FILES, ARCHIVES } from '../scripts/fetch-models.mjs';

const sources = ['src/ui/panels/birdnet-panel.ts', 'src/infrastructure/detector/birdboxDetector.ts'];
const used = new Set(sources.flatMap((f) =>
    [...readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').matchAll(/onDemandUrl\('models\/([^/']+)\//g)].map((m) => m[1])));

test('the app loads models from models/', () => {
    assert.ok(used.size >= 5, [...used].join(', '));
});

for (const name of used) {
    test(`${name} is fetched by scripts/fetch-models.mjs`, () => assert.ok(MODELS.includes(name)));
}

test('pinned downloads carry a SHA-256 each', () => {
    const hashes = [
        ...Object.values(FILES).flatMap((files) => Object.values(files).map(([url, h]) => (assert.match(url, /^https:\/\//), h))),
        ...Object.values(ARCHIVES).flatMap((a) => [a.sha256, ...Object.values(a.files)]),
    ];
    for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
});
