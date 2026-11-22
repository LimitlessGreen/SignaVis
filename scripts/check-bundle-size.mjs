// Size budget for the published library (run after `npm run build`).
// Fails when an entry grows past its budget; says so when it shrank enough to
// lower the budget, so savings are locked in.
//
//   node scripts/check-bundle-size.mjs [--update]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUDGET = path.join(ROOT, 'scripts/bundle-budget.json');
const HEADROOM = 1.02;      // --update: budget = size + 2 %
const LOWER_HINT = 0.95;    // tell when an entry is > 5 % under budget

const budget = JSON.parse(fs.readFileSync(BUDGET, 'utf8'));
const update = process.argv.includes('--update');
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
let failed = false;

for (const [file, limit] of Object.entries(budget.gzip)) {
    const p = path.join(ROOT, 'dist', file);
    if (!fs.existsSync(p)) { console.error(`✗ ${file}: missing (run npm run build)`); failed = true; continue; }
    const raw = fs.readFileSync(p);
    const gz = zlib.gzipSync(raw, { level: 9 }).length;
    if (update) { budget.gzip[file] = Math.ceil(gz * HEADROOM); continue; }
    const line = `${file}: ${kb(gz)} gzip (${kb(raw.length)} raw), budget ${kb(limit)}`;
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
