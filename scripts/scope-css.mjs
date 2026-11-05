#!/usr/bin/env node
// Builds the stylesheet for embedding the player in a host page (Gradio, …).
//
// The library stylesheet is written for a page of its own: it styles :root, html, body
// and *, and its component rules carry a single class, so a host reset such as
// `.gradio-container button { padding: 0; font-size: 100% }` (0,1,1) wins over them.
// Here every rule is confined to the player root (.signavis-embed) and to the popups it
// appends to <body>, which the host marks .signavis-portal — one class more specificity,
// and nothing of it reaches the host page (the stylesheet also carries rules of the
// labeling app with generic class names such as .block or .primary).
//
// usage: node scripts/scope-css.mjs <in.css>... <out.css>   (inputs are concatenated)
import { readFileSync, writeFileSync } from 'node:fs';
import postcss from 'postcss';

const args = process.argv.slice(2);
const output = args.pop();
if (!args.length || !output) {
    console.error('usage: scope-css.mjs <in.css>... <out.css>');
    process.exit(2);
}

const ROOTS = '.signavis-embed, .signavis-portal';
const PREFIX = ':is(.signavis-embed, .signavis-portal)';
// Page geometry belongs to the host page, not to the player.
const PAGE_ONLY = new Set(['width', 'height']);

function scopeSelector(sel) {
    const s = sel.trim();
    if (s === ':root' || s === 'html' || s === 'body') return ROOTS;
    const theme = s.match(/^html(\[data-theme=[^\]]+\])(.*)$/);
    if (theme) {
        const rest = theme[2].trim();
        return rest
            ? `html${theme[1]} ${PREFIX} ${rest}`
            : `html${theme[1]} :is(${ROOTS})`;
    }
    if (s.startsWith('*')) return `.signavis-embed ${s}, .signavis-portal ${s}, .signavis-portal${s.slice(1)}`;
    const rest = /^(html|body)\b/.test(s) ? s.replace(/^(html|body)\s*/, '') : s;
    return `${PREFIX} ${rest}, ${onPortal(rest)}`;
}

/** The selector with its first compound pinned to the popup element itself. */
function onPortal(sel) {
    let depth = 0;
    let end = sel.length;
    let pseudo = -1;
    for (let i = 0; i < sel.length; i++) {
        const c = sel[i];
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (depth === 0 && /[\s>+~]/.test(c)) { end = i; break; }
        else if (depth === 0 && c === ':' && pseudo < 0) pseudo = i;
    }
    const at = pseudo >= 0 ? pseudo : end;
    return `${sel.slice(0, at)}.signavis-portal${sel.slice(at)}`;
}

const root = postcss.parse(args.map((f) => readFileSync(f, 'utf8')).join('\n'));
root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
    const pageRule = rule.selectors.some((s) => ['html', 'body'].includes(s.trim()));
    rule.selectors = rule.selectors.map(scopeSelector);
    rule.selectors = [...new Set(rule.selectors.join(', ').split(/,\s*(?![^()]*\))/))];
    if (pageRule) rule.walkDecls((d) => { if (PAGE_ONLY.has(d.prop)) d.remove(); });
});
writeFileSync(output, root.toString());
