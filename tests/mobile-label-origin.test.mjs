// Mobile viewer: the box rule in _mobile-app.scss forces `border: 2px solid … !important` and
// `opacity: 1` with high specificity. Imported (readonly), locked and similar-call labels must
// still look different from own labels on the phone, as they do on the desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as sass from 'sass';
import postcss from 'postcss';

const css = sass.compile(path.resolve('src/styles/main.scss'), { style: 'expanded', loadPaths: ['src/styles'] }).css;
const root = postcss.parse(css);

/** Declarations of mobile-viewer rules whose selector mentions every given class fragment. */
function mobileDecls(...needles) {
  const out = [];
  root.walkRules((rule) => {
    for (const sel of rule.selectors) {
      if (!sel.includes('html.is-mobile') || !sel.includes('.m-player')) continue;
      if (sel.replace(/:not\([^)]*\)/g, '').includes('--lane')) continue;
      if (!needles.every((n) => sel.includes(n))) continue;
      rule.walkDecls((d) => out.push(d));
      break;
    }
  });
  return out;
}

const has = (decls, prop, re) => decls.some((d) => d.prop === prop && re.test(d.value) && d.important);

test('mobile: imported (readonly) label boxes are dashed', () => {
  assert.ok(has(mobileDecls('spectrogram-label-region--readonly'), 'border-style', /dashed/));
});

test('mobile: locked label boxes are dashed (not machine suggestions)', () => {
  assert.ok(has(mobileDecls('spectrogram-label-region--locked'), 'border-style', /dashed/));
});

test('mobile: similar-call suggestions are dotted', () => {
  assert.ok(has(mobileDecls('spectrogram-label-region--similar'), 'border-style', /dotted/));
});

test('mobile: imported/locked boxes are muted, not forced to full opacity', () => {
  assert.ok(mobileDecls('spectrogram-label-region--readonly').some((d) => d.prop === 'opacity' && Number(d.value) < 1));
});
