// Selectors in a stylesheet that may style the host page outside the player:
// rules whose first compound has no class or id (bare elements, *, :root, …).
// Used by tests/styles-entries.test.mjs; run: node scripts/css-leaks.mjs src/styles/player.scss
import * as sass from 'sass';
/** Selectors of style rules (also inside @media/@supports, not in @keyframes). */
export function topSelectors(css) {
  // walk blocks; skip @keyframes bodies; collect selectors of style rules (also inside @media/@supports)
  const out = []; let i = 0; const stack = [];
  let buf = '';
  for (; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      const head = buf.trim(); buf = '';
      const inKf = stack.some((h) => /^@(-\w+-)?keyframes/.test(h));
      if (!head.startsWith('@') && !inKf) out.push(head);
      stack.push(head);
    } else if (c === '}') { stack.pop(); buf = ''; }
    else if (c === ';' ) { buf = ''; }
    else buf += c;
  }
  return out;
}
export function leaks(css, allow) {
  const bad = new Set();
  for (const sel of topSelectors(css)) for (const s of sel.split(/,(?![^(]*\))/)) {
    const t = s.trim(); if (!t) continue;
    const first = t.split(/\s*[>+~]\s*|\s+(?![^(]*\))/)[0];
    if (/[.#]/.test(first) || first.includes(':where(.daw-shell')) continue;
    if (allow.some((a) => a.test(t))) continue;
    bad.add(t);
  }
  return [...bad];
}
if (process.argv[2]) {
  const css = sass.compile(process.argv[2], { style: 'compressed', loadPaths: ['src/styles'], silenceDeprecations: ['import','global-builtin','color-functions'] }).css;
  console.log(leaks(css, []).join('\n'));
}
