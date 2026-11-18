// A touch drag on the overview window must not become a page pan: without
// touch-action: none the browser cancels the pointer after a few pixels and
// the window only moves a little (seen on phones and tablets).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const scss = fs.readFileSync(new URL('../src/ui/components/overview/overview.scss', import.meta.url), 'utf8');

function block(selector) {
    const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    const m = scss.match(re);
    assert.ok(m, `rule ${selector} not found`);
    return m[2];
}

for (const sel of ['.overview-window', '.overview-window .handle', '.overview-lens']) {
    test(`overview touch: ${sel} disables browser panning`, () => {
        assert.match(block(sel), /touch-action:\s*none/);
    });
}
