import test from 'node:test';
import assert from 'node:assert/strict';
import { presetChoices, presetButtonText } from '../src/ui/panels/editor-chrome.ts';

const sel = (value, opts) => ({ value, options: opts.map(([v, t, disabled = false]) => ({ value: v, textContent: t, disabled })) });
const opts = [['', '— Custom —'], ['birds', 'Birds'], ['owls', 'Owls (PCEN)'], ['-', '────', true], ['user:Night', '⭐ Night']];

test('presetChoices skips the separator and marks the selected one', () => {
  const c = presetChoices(sel('owls', opts));
  assert.equal(c.length, 4);
  assert.deepEqual(c.filter((x) => x.current).map((x) => x.value), ['owls']);
});

test('presetButtonText: name, Custom, favourite star dropped', () => {
  assert.equal(presetButtonText(sel('owls', opts)), 'Owls (PCEN)');
  assert.equal(presetButtonText(sel('', opts)), 'Custom');
  assert.equal(presetButtonText(sel('user:Night', opts)), 'Night');
});
