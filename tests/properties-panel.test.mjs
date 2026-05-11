import test from 'node:test';
import assert from 'node:assert/strict';

// ── Fake DOM ──────────────────────────────────────────────────────────────────

function createFakeElement(tag = 'div') {
  const el = {
    tagName: (tag || '').toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    _handlers: {},
    value: '',
    type: '',
    hidden: false,
    readOnly: false,
    placeholder: '',
    step: '',
    autocomplete: '',
    spellcheck: false,
    _innerHTML: '',
    textContent: '',
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'string') {
          const t = createFakeElement('#text');
          t.textContent = n;
          this.appendChild(t);
        } else { this.appendChild(n); }
      }
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    replaceWith() {},
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    contains(other) {
      if (!other) return false;
      let cur = other;
      while (cur) { if (cur === this) return true; cur = cur.parentNode; }
      return false;
    },
    querySelector(sel) {
      for (const part of sel.split(',').map(s => s.trim())) {
        const f = _search(this, part); if (f) return f;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      for (const part of sel.split(',').map(s => s.trim())) _searchAll(this, part, out);
      return out;
    },
    addEventListener(name, handler) { (this._handlers[name] ||= []).push(handler); },
    removeEventListener(name, handler) {
      if (this._handlers[name]) this._handlers[name] = this._handlers[name].filter(h => h !== handler);
    },
    _emit(name, ev = {}) {
      for (const h of (this._handlers[name] || []).slice()) { try { h(ev); } catch {} }
    },
    focus() { globalThis.document.activeElement = this; },
    blur() {
      if (globalThis.document.activeElement === this) {
        globalThis.document.activeElement = globalThis.document.body;
        this._emit('blur', {});
        // fire change if value changed since last known value
        if (this._valueOnFocus !== undefined && this._valueOnFocus !== this.value) {
          this._emit('change', {});
        }
      }
    },
    select() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] ?? null; },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (_matchesSel(cur, sel)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 100, right: 100, width: 100, height: 100 }; },
    scrollIntoView() {},
    offsetWidth: 1,
  };

  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML || ''; },
    set(v) {
      el._innerHTML = String(v || '');
      if (v === '') {
        // blur any focused child before clearing
        const active = globalThis.document?.activeElement;
        if (active && el.contains(active)) {
          active._emit('blur', {});
          globalThis.document.activeElement = globalThis.document?.body ?? null;
        }
        el.children = [];
      }
    },
  });

  el.classList = {
    _set: new Set(),
    add(...names) { for (const n of names) this._set.add(n); el.className = [...this._set].join(' '); },
    remove(...names) { for (const n of names) this._set.delete(n); el.className = [...this._set].join(' '); },
    toggle(name, force) {
      const has = this._set.has(name);
      const next = force !== undefined ? force : !has;
      next ? this._set.add(name) : this._set.delete(name);
      el.className = [...this._set].join(' ');
      return next;
    },
    contains(name) { return this._set.has(name); },
  };

  return el;
}

function _camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

// Read an attribute from a fake element, checking both direct property and dataset.
function _attrVal(el, attr) {
  if (el[attr] !== undefined) return el[attr];
  if (attr.startsWith('data-')) {
    const key = _camel(attr.slice(5));
    return el.dataset?.[key];
  }
  return undefined;
}

function _matchesSel(el, sel) {
  if (!el || !el.tagName) return false;
  if (sel.startsWith('.')) return el.className?.split(/\s+/).includes(sel.slice(1));
  if (/^[a-zA-Z]+$/.test(sel)) return el.tagName === sel.toUpperCase();
  const m = sel.match(/^\[([a-zA-Z0-9\-]+)(?:=["']?([^"']+)["']?)?\]$/);
  if (m) {
    const v = _attrVal(el, m[1]);
    return m[2] ? String(v ?? '') === m[2] : v !== undefined;
  }
  return false;
}

function _search(root, sel) {
  const q = [root];
  while (q.length) {
    const n = q.shift();
    if (n !== root && _matchesSel(n, sel)) return n;
    for (const c of n.children) q.push(c);
  }
  return null;
}

function _searchAll(root, sel, out) {
  const q = [root];
  while (q.length) {
    const n = q.shift();
    if (n !== root && _matchesSel(n, sel)) out.push(n);
    for (const c of n.children) q.push(c);
  }
}

function createFakeDocument() {
  const body = createFakeElement('body');
  const doc = {
    body,
    activeElement: body,
    documentElement: createFakeElement('html'),
    createElement(tag) { return createFakeElement(tag); },
    createDocumentFragment() { return createFakeElement('fragment'); },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) { return body.querySelector(sel); },
    querySelectorAll(sel) { return body.querySelectorAll(sel); },
  };
  doc.documentElement._handlers = {};
  doc.documentElement.addEventListener = () => {};
  doc.documentElement.getPropertyValue = () => '';
  return doc;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withFakeDOM(fn) {
  const oldDoc = globalThis.document;
  const oldWin = globalThis.window;
  const oldGcs = globalThis.getComputedStyle;
  globalThis.document = createFakeDocument();
  globalThis.window = { innerHeight: 800, innerWidth: 1400,
    addEventListener() {}, removeEventListener() {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try { return await fn(); }
  finally {
    globalThis.document = oldDoc;
    globalThis.window = oldWin;
    globalThis.getComputedStyle = oldGcs;
  }
}

function makeLabel(overrides = {}) {
  return { id: 'L1', label: 'Robin', scientificName: 'Erithacus rubecula',
    start: 1.0, end: 2.0, freqMin: 2000, freqMax: 8000,
    confidence: null, origin: 'manual', author: '', color: '',
    tags: {}, setId: null, ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('_renderSig: in-place patch when only values change', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    const lbl = makeLabel();
    panel.pinLabel(lbl);

    const sigAfterPin = panel._renderSig;
    const instancesBefore = panel._esInstances; // capture reference, not copy

    // refreshLabel with updated value — same structure
    panel.refreshLabel({ ...lbl, author: 'Alice' });

    assert.equal(panel._renderSig, sigAfterPin, 'signature should not change for value-only update');
    assert.equal(panel._esInstances, instancesBefore, '_esInstances array should be the same reference (no rebuild)');

    // The author input should reflect the new value
    const authorInput = panel._lblBody.querySelector('[data-focus-key="field:author"]');
    assert.ok(authorInput, 'author input should exist');
    assert.equal(authorInput.value, 'Alice', 'author input value should be updated in-place');
  });
});

test('_renderSig: full rebuild when label ID changes', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    panel.pinLabel(makeLabel({ id: 'L1' }));
    const sig1 = panel._renderSig;

    panel.pinLabel(makeLabel({ id: 'L2' }));
    assert.notEqual(panel._renderSig, sig1, 'signature must change when label ID changes');
  });
});

test('_renderSig: full rebuild when locked state changes', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    panel.pinLabel(makeLabel({ id: 'L1' }));
    const sig1 = panel._renderSig;

    panel.setLockedIds(['L1']);
    assert.notEqual(panel._renderSig, sig1, 'signature must change when label becomes locked');
  });
});

test('_renderSig: full rebuild when custom tag keys change', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    const lbl = makeLabel({ tags: {} });
    panel.pinLabel(lbl);
    const sig1 = panel._renderSig;

    panel.refreshLabel({ ...lbl, tags: { myKey: 'value' } });
    assert.notEqual(panel._renderSig, sig1, 'adding a custom tag key must trigger full rebuild');
  });
});

test('_patchValues: focused input is not overwritten', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    const lbl = makeLabel({ author: 'Alice' });
    panel.pinLabel(lbl);

    const authorInput = panel._lblBody.querySelector('[data-focus-key="field:author"]');
    assert.ok(authorInput, 'author input should exist');

    // Simulate user typing in the author field
    authorInput.focus();
    authorInput.value = 'Bob (typing...)';

    // External refresh with a different author value should not overwrite the focused input
    panel.refreshLabel({ ...lbl, author: 'Carol' });

    assert.equal(authorInput.value, 'Bob (typing...)',
      'focused input should not be overwritten during in-place patch');
  });
});

test('_patchValues: non-focused inputs are updated', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    const lbl = makeLabel({ author: 'Alice', start: 1.0, end: 2.0 });
    panel.pinLabel(lbl);

    const authorInput = panel._lblBody.querySelector('[data-focus-key="field:author"]');
    const startInput  = panel._lblBody.querySelector('[data-focus-key="field:start"]');
    assert.ok(authorInput && startInput);

    // Focus author — only start should update
    authorInput.focus();
    panel.refreshLabel({ ...lbl, author: 'SHOULD_NOT_CHANGE', start: 5.0 });

    assert.equal(authorInput.value, 'Alice', 'focused input not overwritten');
    assert.equal(startInput.value, '5', 'non-focused input updated');
  });
});

test('hoverLabel is skipped when a panel input is focused', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    const pinned = makeLabel({ id: 'L1', label: 'Robin' });
    panel.pinLabel(pinned);

    const authorInput = panel._lblBody.querySelector('[data-focus-key="field:author"]');
    authorInput.focus();

    const sigBefore = panel._renderSig;

    // hoverLabel with a different label should be suppressed
    panel.hoverLabel(makeLabel({ id: 'L2', label: 'Blackbird' }));

    assert.equal(panel._renderSig, sigBefore, 'no rebuild should happen while panel input is focused');
    assert.equal(panel._hoverLabel?.id, 'L2', '_hoverLabel state is still updated');

    // After blur, hoverLabel should take effect on next call
    authorInput.blur();
    panel.hoverLabel(makeLabel({ id: 'L2', label: 'Blackbird' }));
    assert.notEqual(panel._renderSig, sigBefore, 'hover rebuild should fire after focus is released');
  });
});

test('clearHover is skipped when a panel input is focused', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    const pinned = makeLabel({ id: 'L1' });
    panel.pinLabel(pinned);

    // Focus an input while showing pinned label (editable)
    const authorInput = panel._lblBody.querySelector('[data-focus-key="field:author"]');
    assert.ok(authorInput);
    authorInput.focus();
    const sigPinned = panel._renderSig;

    // hoverLabel and clearHover are both suppressed while input is focused
    panel.hoverLabel(makeLabel({ id: 'L2' }));
    assert.equal(panel._renderSig, sigPinned, 'hoverLabel suppressed while input focused');
    assert.equal(panel._hoverLabel?.id, 'L2', '_hoverLabel state updated despite no rebuild');

    panel.clearHover();
    assert.equal(panel._renderSig, sigPinned, 'clearHover suppressed while input focused');
    assert.equal(panel._hoverLabel, null, '_hoverLabel cleared');

    // After blur, clearHover should trigger a rebuild
    authorInput.blur();
    panel.hoverLabel(makeLabel({ id: 'L2' }));
    const sigHover = panel._renderSig;
    panel.clearHover();
    assert.notEqual(panel._renderSig, sigHover, 'clearHover rebuilds after focus released');
  });
});

test('Enter key on text input triggers blur and change', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const state = { labels: [makeLabel({ author: '' })] };
    const panel = new PropertiesPanel();

    let changeCount = 0;
    panel.onChange = (id, updates) => {
      const idx = state.labels.findIndex(l => l.id === id);
      if (idx >= 0) state.labels[idx] = { ...state.labels[idx], ...updates };
      panel.refreshLabel(state.labels[idx]);
      changeCount++;
    };
    panel.pinLabel(state.labels[0]);

    const authorInput = panel._lblBody.querySelector('[data-focus-key="field:author"]');
    assert.ok(authorInput, 'author input must exist');

    authorInput.focus();
    authorInput.value = 'Alice';
    authorInput._valueOnFocus = ''; // simulate focus baseline

    // Press Enter
    authorInput._emit('keydown', { key: 'Enter', preventDefault() {} });

    assert.equal(globalThis.document.activeElement, globalThis.document.body,
      'Enter should trigger blur');
    assert.equal(changeCount, 1, 'change should have fired once');
    assert.equal(state.labels[0].author, 'Alice', 'author should be saved');
  });
});

test('set-field data-focus-key: in-place patch updates set fields', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const setInfo = { name: 'My Set', creator: 'Alice', license: '', origin: 'manual' };
    const panel = new PropertiesPanel({
      getSetInfo: (id) => id === 'S1' ? setInfo : null,
    });
    const lbl = makeLabel({ setId: 'S1' });
    panel.pinLabel(lbl);

    const nameInput = panel._setBody.querySelector('[data-focus-key="set:name"]');
    assert.ok(nameInput, 'set name input should have data-focus-key');
    assert.equal(nameInput.value, 'My Set');

    // Simulate external set update — same label structure, just value changed
    setInfo.name = 'Renamed Set';
    panel.refreshLabel({ ...lbl }); // triggers _patchValues since sig unchanged

    assert.equal(nameInput.value, 'Renamed Set', 'set field updated in-place');
  });
});

test('number field in-place update preserves numeric formatting', async () => {
  await withFakeDOM(async () => {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const panel = new PropertiesPanel();
    panel.pinLabel(makeLabel({ start: 1.234 }));

    const startInput = panel._lblBody.querySelector('[data-focus-key="field:start"]');
    assert.ok(startInput);
    assert.equal(Number(startInput.value), 1.234);

    panel.refreshLabel(makeLabel({ start: 5.678 }));
    assert.equal(Number(startInput.value), 5.678, 'number field updated in-place');
  });
});
