// Ratchet for the library split: the player core may not start pulling in
// another optional module (labels, XC, BirdNET, live, taxonomy, …) statically,
// and every module that gets decoupled must leave the baseline list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reachable, chainTo } from '../scripts/module-graph.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASELINE = path.join(ROOT, 'tests/fixtures/core-coupling-baseline.json');
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const SRC = path.join(ROOT, 'src');

const isOptional = (f) => base.optional.some((p) => f.startsWith(p));

test('core entry pulls in no new optional module', () => {
    const coupled = reachable(path.join(ROOT, base.entry), SRC).filter(isOptional);
    const added = coupled.filter((f) => !base.stillCoupled.includes(f));
    assert.deepEqual(added, [], added.map((f) =>
        `${f} is now statically imported by the core:\n  ${chainTo(path.join(ROOT, base.entry), f, SRC).join(' → ')}\n` +
        '  Import it lazily (await import()) or through a plugin instead.').join('\n'));
});

test('baseline lists only modules that are still coupled (ratchet)', () => {
    const coupled = new Set(reachable(path.join(ROOT, base.entry), SRC).filter(isOptional));
    const gone = base.stillCoupled.filter((f) => !coupled.has(f));
    assert.deepEqual(gone, [], `decoupled — remove from tests/fixtures/core-coupling-baseline.json stillCoupled:\n${gone.join('\n')}`);
});

test('module graph follows multi-line imports and skips type-only imports', () => {
    const dir = fs.mkdtempSync(path.join(ROOT, 'tests/.tmp-graph-'));
    try {
        fs.writeFileSync(path.join(dir, 'a.ts'), "import {\n  b,\n} from './b.ts';\nimport type { C } from './c.ts';\nexport { d } from './d';\n// import './e.ts';\nconst lazy = () => import('./f.ts');\n");
        for (const n of ['b', 'c', 'd', 'e', 'f']) fs.writeFileSync(path.join(dir, `${n}.ts`), `export const ${n} = 1;\n`);
        assert.deepEqual(reachable(path.join(dir, 'a.ts'), dir), ['a.ts', 'b.ts', 'd.ts']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
