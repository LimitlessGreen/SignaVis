// CSS per package entry (after vite build): dist/core.css, dist/label-table.css.
// Each is the entry's stylesheet plus the .scss files its modules import
// (also from lazy chunks, e.g. the label editor's modal; sorted by path), minus what an
// earlier entry already ships (label-table.css goes on top of core.css).
// dist/birdnet-player.css (all of them) comes from the vite build itself.
import fs from 'node:fs';
import path from 'node:path';
import * as sass from 'sass';
import { PACKAGE_ENTRIES } from './package-entries.mjs';
import { reachable } from './module-graph.mjs';
import { isMain } from './is-main.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

/** .scss files imported by TS/JS modules reachable from the entry, sorted by path. */
export function moduleStylesheets(entrySrc) {
    return reachable(path.join(ROOT, entrySrc), SRC, { dynamic: true }).filter((f) => f.endsWith('.scss') && !f.startsWith('styles/'));
}

// Sass puts a byte order mark before output with non-ASCII characters. Joined
// parts must not carry one inside the file (it would void the next rule);
// the file gets a single one at the start, so it is read as UTF-8.
const BOM = '\uFEFF';
function compile(file) {
    return sass.compile(file, {
        style: 'compressed',
        loadPaths: [path.join(ROOT, 'src/styles')],
        silenceDeprecations: ['import', 'global-builtin', 'color-functions'],
    }).css.replace(/^\uFEFF/, '');
}

/** { name → { css, extra } } for every entry with a stylesheet, in PACKAGE_ENTRIES order. */
export function buildEntryCss() {
    const out = {};
    const shipped = new Set();
    for (const [name, e] of Object.entries(PACKAGE_ENTRIES)) {
        if (!e.scss) continue;
        const extra = moduleStylesheets(e.src).filter((f) => !shipped.has(f));
        for (const f of extra) shipped.add(f);
        out[name] = { css: BOM + [compile(path.join(ROOT, e.scss)), ...extra.map((f) => compile(path.join(SRC, f)))].join('\n'), extra };
    }
    return out;
}

if (isMain(import.meta.url)) {
    fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
    for (const [name, { css, extra }] of Object.entries(buildEntryCss())) {
        fs.writeFileSync(path.join(ROOT, 'dist', `${name}.css`), css);
        console.log(`dist/${name}.css ${(css.length / 1024).toFixed(1)} kB${extra.length ? ` (+ ${extra.join(', ')})` : ''}`);
    }
}
