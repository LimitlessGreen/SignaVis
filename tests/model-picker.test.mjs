import test from 'node:test';
import assert from 'node:assert/strict';
import { initModelPicker } from '../src/ui/panels/model-picker.ts';

class El extends EventTarget {
  constructor(props = {}) { super(); this.hidden = false; this.dataset = {}; this.attrs = {}; Object.assign(this, props); }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() { globalThis.document.activeElement = this; }
  blur() { globalThis.document.activeElement = null; this.dispatchEvent(new Event('blur')); }
}

function setup() {
  globalThis.document = { activeElement: null };
  const btns = ['v2.4', 'v3.0', 'custom'].map((v) => new El({ dataset: { value: v } }));
  const seg = new El({ querySelectorAll: () => btns });
  const select = new El({ value: 'v2.4' });
  const urlInput = new El({ value: '' });
  // Stand-in for BirdNETPanel: detects a preset from the typed URL (registered first)
  urlInput.addEventListener('input', () => {
    const v = urlInput.value === '../models/birdnet-v3.0/' ? 'v3.0' : 'custom';
    if (select.value !== v) { select.value = v; select.dispatchEvent(new Event('change')); }
  });
  initModelPicker({ seg, select, urlInput });
  return { btns, select, urlInput };
}

test('URL field stays visible while typing passes a preset-matching value', () => {
  const { btns, select, urlInput } = setup();
  btns[2].dispatchEvent(new Event('click'));
  assert.equal(select.value, 'custom');
  assert.equal(urlInput.hidden, false);
  urlInput.focus();
  for (const v of ['../models/birdnet-v3.0/', '../models/birdnet-v3.0/alternative/']) {
    urlInput.value = v;
    urlInput.dispatchEvent(new Event('input'));
    assert.equal(urlInput.hidden, false, `hidden at ${v}`);
  }
  assert.equal(select.value, 'custom');
});

test('URL field hides once editing ends on a preset URL', () => {
  const { select, urlInput } = setup();
  select.value = 'custom'; select.dispatchEvent(new Event('change'));
  urlInput.focus();
  urlInput.value = '../models/birdnet-v3.0/';
  urlInput.dispatchEvent(new Event('input'));
  assert.equal(urlInput.hidden, false);
  urlInput.blur();
  assert.equal(select.value, 'v3.0');
  assert.equal(urlInput.hidden, true);
});
