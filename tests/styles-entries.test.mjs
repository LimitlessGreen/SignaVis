// Library stylesheets: same cascade as the app, nothing that restyles the host
// page, and joined parts without a stray byte order mark.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as sass from 'sass';
import { leaks } from '../scripts/css-leaks.mjs';
import { buildEntryCss } from '../scripts/build-css.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const uses = (f) => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/^@use "([^"]+)"/gm)].map((m) => m[1]);
const compile = (f) => sass.compile(path.join(ROOT, f), {
    style: 'compressed', loadPaths: [path.join(ROOT, 'src/styles')],
    silenceDeprecations: ['import', 'global-builtin', 'color-functions'],
}).css;

// Allowed outside .daw-shell: theme variables on <html> (and rules scoped under
// them), the player's own data-aw hooks, and [hidden] { display: none }.
const ALLOW = [/^html(\[data-theme=\w+\]|:not\(\[data-theme=\w+\]\))/, /^\[data-aw=/, /^\[hidden\]$/];

for (const entry of ['src/styles/player.scss', 'src/styles/label-table.scss']) {
    test(`${path.basename(entry)} uses partials of main.scss in the same order`, () => {
        const app = uses('src/styles/main.scss');
        const own = uses(entry);
        const missing = own.filter((u) => !app.includes(u));
        assert.deepEqual(missing, [], 'partials not in main.scss');
        const idx = own.map((u) => app.indexOf(u));
        assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `order differs from main.scss: ${own.join(', ')}`);
    });

    test(`${path.basename(entry)} does not style the host page`, () => {
        assert.deepEqual(leaks(compile(entry), ALLOW), []);
    });
}

test('the app keeps its page-wide rules (scrollbars, selects, checkboxes)', () => {
    const css = compile('src/styles/main.scss');
    assert.match(css, /(^|[}\s,])\*::-webkit-scrollbar\{/);
    assert.match(css, /(^|[}\s,])select:not\(\[multiple\]\):not\(\[size\]\)\{/);
    const player = compile('src/styles/player.scss');
    assert.match(player, /:where\(\.daw-shell\) \*::-webkit-scrollbar\{/);
    assert.match(player, /:where\(\.daw-shell\) select:not\(\[multiple\]\):not\(\[size\]\)\{/);
});

test('entry CSS: one byte order mark at the start, component stylesheets included once', () => {
    const out = buildEntryCss();
    for (const [name, { css }] of Object.entries(out)) {
        assert.equal(css.indexOf('﻿'), 0, `${name}: BOM at start`);
        assert.equal(css.lastIndexOf('﻿'), 0, `${name}: BOM inside the file voids the next rule`);
    }
    assert.ok(out.core.extra.includes('ui/components/modal/modal.scss'), 'core.css carries the label editor modal');
    assert.ok(!out['label-table'].extra.some((f) => out.core.extra.includes(f)), 'label-table.css repeats nothing of core.css');
});

test('assembled entry CSS (with component stylesheets) does not style the host page', () => {
    for (const [name, { css }] of Object.entries(buildEntryCss())) assert.deepEqual(leaks(css, ALLOW), [], name);
});

test('css-leaks finds bare element rules and ignores scoped ones', () => {
    const css = 'tag-badge{a:b}.x{a:b}:where(.daw-shell) select{a:b}*::-webkit-scrollbar{a:b}@media (x){input[type=checkbox]{a:b}}@keyframes k{from{a:b}to{a:b}}';
    assert.deepEqual(leaks(css, []), ['tag-badge', '*::-webkit-scrollbar', 'input[type=checkbox]']);
});

test('css-leaks: a dot in an attribute value or a negated class is no scope', () => {
    const css = '[data-host=".menu"]{a:b}:not(.daw-shell) p{a:b}div:not(.x){a:b}.daw-shell button{a:b}#id a{a:b}button.x{a:b}';
    assert.deepEqual(leaks(css, []), ['[data-host=".menu"]', ':not(.daw-shell) p', 'div:not(.x)']);
});
