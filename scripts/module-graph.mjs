// Static import graph of src/ from an entry file: what a bundler must include
// when a host imports that entry. Follows `import … from`, `export … from` and
// side-effect imports; skips `import type` / `export type`, and dynamic import()
// unless { dynamic: true } (lazy chunks load only when used).
//
//   node scripts/module-graph.mjs src/app/BirdNETPlayer.ts [--sizes]
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './is-main.mjs';

// `import'./a.scss'` and `import{ x }from'./b'` need no whitespace; `import type`/`export type`
// (also `type{`) are erased and skipped.
const STATIC_RE = /(?:^|[\n;])\s*(import|export)(?![\w$])\s*(type(?![\w$])\s*)?(?:[\w*{}\s,$]+?(?<![\w$])from(?![\w$])\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]\s*\)/g;

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function resolveSpec(from, spec) {
    if (!spec.startsWith('.')) return null;                 // package: not ours
    const clean = spec.replace(/\?.*$/, '');
    const base = path.resolve(path.dirname(from), clean);
    for (const c of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

/**
 * Map of absolute file → set of absolute files it imports statically
 * (with { dynamic: true } also through import('…'): everything a host may load).
 */
export function moduleGraph(entry, { dynamic = false } = {}) {
    const graph = new Map();
    const todo = [path.resolve(entry)];
    while (todo.length) {
        const file = todo.pop();
        if (graph.has(file)) continue;
        const deps = new Set();
        graph.set(file, deps);
        if (!/\.(ts|js|mjs)$/.test(file)) continue;          // css/scss/wasm: leaf
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        for (const m of src.matchAll(STATIC_RE)) {
            if (m[2]) continue;                              // import type / export type
            const dep = resolveSpec(file, m[3]);
            if (dep) { deps.add(dep); todo.push(dep); }
        }
        if (dynamic) {
            for (const m of src.matchAll(DYNAMIC_RE)) {
                const dep = resolveSpec(file, m[1]);
                if (dep) { deps.add(dep); todo.push(dep); }
            }
        }
    }
    return graph;
}

/** Files reachable from entry, relative to src/ with forward slashes. */
export function reachable(entry, srcRoot = path.resolve('src'), opts = {}) {
    return [...moduleGraph(entry, opts).keys()]
        .map((f) => path.relative(srcRoot, f).split(path.sep).join('/'))
        .sort();
}

/** One import chain entry → target (relative paths), for error messages. */
export function chainTo(entry, target, srcRoot = path.resolve('src')) {
    const graph = moduleGraph(entry);
    const start = path.resolve(entry);
    const goal = path.resolve(srcRoot, target);
    const prev = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
        const f = queue.shift();
        if (f === goal) break;
        for (const d of graph.get(f) ?? []) if (!prev.has(d)) { prev.set(d, f); queue.push(d); }
    }
    if (!prev.has(goal)) return [];
    const out = [];
    for (let f = goal; f; f = prev.get(f)) out.unshift(path.relative(srcRoot, f).split(path.sep).join('/'));
    return out;
}

if (isMain(import.meta.url)) {
    const entry = process.argv[2] || 'src/app/BirdNETPlayer.ts';
    const files = reachable(entry);
    if (process.argv.includes('--sizes')) {
        const rows = files.map((f) => [fs.statSync(path.resolve('src', f)).size, f]).sort((a, b) => b[0] - a[0]);
        const total = rows.reduce((s, r) => s + r[0], 0);
        for (const [s, f] of rows) console.log(String(s).padStart(8), f);
        console.log(`${files.length} files, ${total} bytes of source`);
    } else {
        console.log(files.join('\n'));
    }
}
