// Labels on the phone must keep their origin visible (label design plan, SignaVis-lab):
// the old mobile box rule forced `border: 2px solid … !important` and `opacity: 1`, so imported,
// locked and similar-call labels looked exactly like own labels. The phone now uses the shared
// label styles and only feeds the species colour; nothing on the phone may force the frame again.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as sass from 'sass';
import postcss from 'postcss';

const css = sass.compile(path.resolve('src/styles/main.scss'), { style: 'expanded', loadPaths: ['src/styles'] }).css;
const root = postcss.parse(css);

function decls(match) {
  const out = [];
  root.walkRules((rule) => { if (rule.selectors.some(match)) rule.walkDecls((d) => out.push({ sel: rule.selector, d })); });
  return out;
}
const mobile = (sel) => sel.includes('html.is-mobile') && sel.includes('.m-player') && sel.includes('spectrogram-label-region');

test('mobile: no rule forces the label frame style or full opacity', () => {
  const bad = decls(mobile).filter(({ d }) =>
    (/^border(-style)?$/.test(d.prop) && d.important) || (d.prop === 'opacity' && Number(d.value) === 1));
  assert.deepEqual(bad.map(({ sel, d }) => `${sel} { ${d.prop}: ${d.value} }`), []);
});

test('shared: similar-call suggestions are dotted', () => {
  assert.ok(decls((s) => s.includes('.suggestion.spectrogram-label-region--similar'))
    .some(({ d }) => d.prop === 'border-style' && d.value === 'dotted'));
});

test('shared: imported labels have a thin frame and a dashed tag', () => {
  const ro = decls((s) => s.includes('.spectrogram-label-region--readonly') && !s.includes('handle'));
  assert.ok(ro.some(({ d }) => d.prop === 'border-width' && d.value === '1px'));
  assert.ok(ro.some(({ sel, d }) => sel.includes('spectrogram-label-text') && /^border(-style)?$/.test(d.prop) && d.value.includes('dashed')));
});

test('shared: detector boxes are amber and dashed', () => {
  const sug = decls((s) => /\.spectrogram-label-region\.suggestion$/.test(s));
  assert.ok(sug.some(({ d }) => d.prop === '--label-c' && d.value.includes('--label-suggestion')));
  assert.ok(sug.some(({ d }) => d.prop === 'border-style' && d.value === 'dashed'));
});

test('mobile: dimmed species stay recognisable (35 %)', () => {
  const dim = decls((s) => s.includes('.m-dim'));
  assert.ok(dim.some(({ d }) => d.prop === 'opacity' && d.value.includes('--label-dimmed')));
  assert.ok(/--label-dimmed:\s*0\.35/.test(css));
});
