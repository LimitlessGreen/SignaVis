// The species field in the "New label" dialog must follow the theme's text colour;
// a fixed light colour made the typed name unreadable on the light theme.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const scss = fs.readFileSync(new URL('../src/styles/components/_overlays.scss', import.meta.url), 'utf8');

test('label search input uses the theme text colour', () => {
    const m = scss.match(/(^|\n)\.label-search-input\s*\{([^}]*)\}/);
    assert.ok(m, 'rule .label-search-input not found');
    assert.match(m[2], /color:\s*var\(--color-text-primary\)/);
});
