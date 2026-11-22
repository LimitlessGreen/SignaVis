// Size budget for the published library (run after `npm run build`).
// An ESM entry is measured with every chunk it imports statically (what a host
// downloads when it imports that entry; lazy import() chunks are not counted);
// a feature entry with a base (package-entries.mjs) without the base's files.
// Fails when an entry grows past its budget; says so when it shrank enough to
// lower the budget, so savings are locked in.
//
//   node scripts/check-bundle-size.mjs [--update]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PACKAGE_ENTRIES } from './package-entries.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUDGET = path.join(ROOT, 'scripts/bundle-budget.json');
const HEADROOM = 1.02;      // --update: budget = size + 2 %
const LOWER_HINT = 0.95;    // tell when an entry is > 5 % under budget

// Static imports of a built ES module: `import … from "./x.js"`, `import "./x.js"`, `export … from "./x.js"`.
const STATIC_IMPORT_RE = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["'](\.\/[^"']+\.js)["']/g;

/** The file plus every dist chunk it imports statically. */
export function staticClosure(file, dist = DIST) {
    const seen = new Set();
    const todo = [file];
    while (todo.length) {
        const f = todo.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        if (!f.endsWith('.js')) continue;
        const code = fs.readFileSync(path.join(dist, f), 'utf8');
        for (const m of code.matchAll(STATIC_IMPORT_RE)) todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])));
    }
    return [...seen];
}

function measure(file) {
    let files = file.endsWith('.esm.js') ? staticClosure(file) : [file];
    // A feature entry runs on top of its base (e.g. core): count only what it adds.
    const base = PACKAGE_ENTRIES[file.replace(/\.esm\.js$/, '')]?.base;
    if (base) {
        const shared = new Set(staticClosure(`${base}.esm.js`));
        files = files.filter((f) => !shared.has(f));
    }
    let raw = 0;
    let gz = 0;
    for (const f of files) {
        const buf = fs.readFileSync(path.join(DIST, f));
        raw += buf.length;
        gz += zlib.gzipSync(buf, { level: 9 }).length;
    }
    return { raw, gz, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const budget = JSON.parse(fs.readFileSync(BUDGET, 'utf8'));
    const update = process.argv.includes('--update');
    const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
    let failed = false;

    for (const [file, limit] of Object.entries(budget.gzip)) {
        if (!fs.existsSync(path.join(DIST, file))) { console.error(`✗ ${file}: missing (run npm run build)`); failed = true; continue; }
        const { raw, gz, files } = measure(file);
        if (update) { budget.gzip[file] = Math.ceil(gz * HEADROOM); continue; }
        const base = PACKAGE_ENTRIES[file.replace(/\.esm\.js$/, '')]?.base;
        const parts = (files.length > 1 ? `, ${files.length} files` : '') + (base ? `, on top of ${base}` : '');
        const line = `${file}: ${kb(gz)} gzip (${kb(raw)} raw${parts}), budget ${kb(limit)}`;
        if (gz > limit) { console.error(`✗ ${line} — over budget`); failed = true; }
        else if (gz < limit * LOWER_HINT) console.log(`✓ ${line} — well under budget, lower it: node scripts/check-bundle-size.mjs --update`);
        else console.log(`✓ ${line}`);
    }

    if (update) {
        fs.writeFileSync(BUDGET, `${JSON.stringify(budget, null, 2)}\n`);
        console.log('budget updated', budget.gzip);
    } else if (failed) {
        console.error('\nBundle over budget. Load the new code lazily or as an optional entry; raise the budget only on purpose (--update).');
        process.exit(1);
    }
}
