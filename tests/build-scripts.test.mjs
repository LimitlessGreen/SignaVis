// Helpers of the build scripts: direct-run detection and the static import scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from '../scripts/is-main.mjs';
import { reachable } from '../scripts/module-graph.mjs';

test('isMain compares file URLs (spaces, relative paths), false without argv[1]', () => {
    const file = path.join(os.tmpdir(), 'dir with space', 'build-css.mjs');
    const url = pathToFileURL(file).href;
    assert.ok(url.includes('%20'));
    assert.equal(isMain(url, file), true);
    assert.equal(isMain(url, path.relative(process.cwd(), file)), true);
    assert.equal(isMain(url, path.join(os.tmpdir(), 'other.mjs')), false);
    assert.equal(isMain(url, undefined), false);
});

test('module graph follows compact imports and value re-exports, skips type-only ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgraph-'));
    const w = (f, src) => fs.writeFileSync(path.join(dir, f), src);
    w('entry.ts', [
        "import'./side.scss';",
        "import{ a }from'./a.ts';",
        "import * as b from \"./b.ts\";",
        "export{ c }from'./c.ts';",
        "export * from './d.ts';",
        "import type { T } from './t1.ts';",
        "import type{ U }from'./t2.ts';",
        "export type { V } from './t3.ts';",
        "const typeName = 1; export { typeName };",
    ].join('\n'));
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 't1.ts', 't2.ts', 't3.ts']) w(f, 'export const x = 1;\n');
    w('side.scss', '.x{}');
    assert.deepEqual(reachable(path.join(dir, 'entry.ts'), dir), ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'entry.ts', 'side.scss']);
    fs.rmSync(dir, { recursive: true, force: true });
});
