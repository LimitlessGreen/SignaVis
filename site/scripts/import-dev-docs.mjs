// Imports the developer docs from ../docs (MkDocs-style Markdown) into Starlight,
// keeping their old URLs (/SignaVis/docs/<path>/) so search engines and store
// listings (e.g. the Lite privacy policy) keep working.
// ../docs stays the single source; the output folder is generated and git-ignored.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'docs');
const OUT = join(here, '..', 'src', 'content', 'docs', 'docs', 'dev');
const BASE = '/SignaVis/docs';
const SKIP = new Set(['index.md', 'diagrams/README.md']);

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
});

/** Old MkDocs page path ('labeling/index.md') -> URL path below /docs ('labeling/'). */
const urlOf = (rel) => rel.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '/');

const keys = (s) => s.replace(/\+\+([^+\s][^\s]*?)\+\+/g, (_, k) =>
  k.split('+').map((x) => `<kbd>${x.replace(/^"|"$/g, '').replace(/-/g, ' ')}</kbd>`).join(' + '));

const yaml = (s) => JSON.stringify(s);

rmSync(OUT, { recursive: true, force: true });
const pages = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split('\\').join('/');
  if (SKIP.has(rel)) continue;
  let md = readFileSync(file, 'utf8');
  // Fallback title from the file name: 'xeno-canto-format.md' -> 'Xeno-canto format'.
  let title = rel.split('/').pop().replace(/\.md$/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) { title = fm[1].match(/^title:\s*(.+)$/m)?.[1].trim() ?? title; md = md.slice(fm[0].length); }
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) { if (!fm) title = h1[1].trim(); md = md.replace(h1[0], ''); }
  const para = md.split('\n').map((l) => l.trim()).find((l) => l && !/^[#<|!*`>-]/.test(l)) ?? '';
  // Search snippets need some substance; prefix short intros with context.
  const desc = para.length >= 70 ? para : `SignaVis developer documentation: ${title}.${para ? ' ' + para : ''}`;
  const pageUrl = urlOf(rel);
  // Rewrite relative .md links and img/ paths to absolute URLs.
  md = md.replace(/\]\((?!https?:|#|\/)([^)\s]+?)(#[^)]*)?\)/g, (m, target, hash = '') => {
    const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
    if (target.endsWith('.md')) return `](${BASE}/${urlOf(resolved)}${hash})`;
    if (/\.(png|jpe?g|svg|gif)$/i.test(target)) return `](${BASE}/${resolved})`;
    return m;
  });
  md = md.replace(/src="(?!https?:|\/)([^"]+)"/g, (_, p) => `src="${BASE}/${posix.normalize(posix.join(posix.dirname(rel), p))}"`);
  md = keys(md);
  // Slug keeps the old URL: docs/<old path>, independent of the dev/ folder name.
  const slug = `docs/${pageUrl.replace(/\/$/, '')}`.replace(/\/$/, '');
  const out = join(OUT, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `---\ntitle: ${yaml(title)}\ndescription: ${yaml(desc.slice(0, 160))}\nslug: ${slug}\n---\n\n<!-- Generated from docs/${rel} by site/scripts/import-dev-docs.mjs. Edit the source. -->\n${md}`);
  pages.push({ slug, title });
}
// Images used by the old docs, served under their old URL.
cpSync(join(SRC, 'img'), join(here, '..', 'public', 'docs', 'img'), { recursive: true });
writeFileSync(join(OUT, '..', 'dev-pages.json'), JSON.stringify(pages.sort((a, b) => a.slug.localeCompare(b.slug)), null, 2));
console.log(`imported ${pages.length} developer pages`);
