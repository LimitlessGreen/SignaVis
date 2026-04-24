import test from 'node:test';
import assert from 'node:assert/strict';

// We'll dynamically import the module under test after installing a minimal
// fake `document` so the DOM-creating label editor can run in Node.

function createFakeElement(tag = 'div') {
  const el = {
    tagName: (tag || '').toUpperCase(),
    className: '',
    classList: null,
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    _handlers: {},
    value: '',
    hidden: false,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    // DOM `append` accepts multiple nodes/strings — emulate by delegating
    append(...nodes) {
      for (const n of nodes) {
        // If it's a string, create a text-node-like object
        if (typeof n === 'string') {
          const t = { tagName: '#text', textContent: n, parentNode: null };
          this.appendChild(t);
        } else {
          this.appendChild(n);
        }
      }
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    querySelector(selector) {
      if (!selector) return null;
      // support comma lists: try each in order
      const parts = selector.split(',').map(s => s.trim());
      for (const part of parts) {
        const found = this._search(part);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(selector) {
      const out = [];
      const parts = selector.split(',').map(s => s.trim());
      for (const part of parts) {
        this._searchAll(part, out);
      }
      return out;
    },
    _search(sel) {
      // class selector
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        // BFS
        const q = [this];
        while (q.length) {
          const n = q.shift();
          if (n.className && n.className.split(/\s+/).includes(cls)) return n;
          for (const c of n.children) q.push(c);
        }
        return null;
      }
      // tag selector
      if (/^[a-zA-Z]+$/.test(sel)) {
        const tag = sel.toUpperCase();
        const q = [this];
        while (q.length) {
          const n = q.shift();
          if (n.tagName === tag) return n;
          for (const c of n.children) q.push(c);
        }
        return null;
      }
      // attribute selector [role="dialog"]
      const m = sel.match(/^\[([a-zA-Z0-9\-]+)(?:=(?:"|')?([^"']+)(?:"|')?)?\]$/);
      if (m) {
        const attr = m[1];
        const val = m[2];
        const q = [this];
        while (q.length) {
          const n = q.shift();
          if (typeof n[attr] !== 'undefined') {
            if (!val) return n;
            if (String(n[attr]) === val) return n;
          }
          for (const c of n.children) q.push(c);
        }
        return null;
      }
      return null;
    },
    _searchAll(sel, out) {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        const q = [this];
        while (q.length) {
          const n = q.shift();
          if (n.className && n.className.split(/\s+/).includes(cls)) out.push(n);
          for (const c of n.children) q.push(c);
        }
        return;
      }
      // fallback: no-op
    },
    addEventListener(name, handler) {
      (this._handlers[name] ||= []).push(handler);
    },
    removeEventListener(name, handler) {
      if (!this._handlers[name]) return;
      this._handlers[name] = this._handlers[name].filter(h => h !== handler);
    },
    _emit(name, ev = {}) {
      const handlers = this._handlers[name] || [];
      for (const h of handlers.slice()) {
        try { h(ev); } catch (e) { /* ignore in test harness */ }
      }
    },
    focus() { globalThis.document.activeElement = this; },
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; },
    select() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
  };
  // lightweight classList implementation that mirrors DOM behavior used by the
  // code under test (add/remove/toggle/contains)
  el.classList = {
    _set: new Set(),
    add(...names) { for (const n of names) this._set.add(n); el.className = Array.from(this._set).join(' '); },
    remove(...names) { for (const n of names) this._set.delete(n); el.className = Array.from(this._set).join(' '); },
    toggle(name) { if (this._set.has(name)) { this._set.delete(name); el.className = Array.from(this._set).join(' '); return false; } this._set.add(name); el.className = Array.from(this._set).join(' '); return true; },
    contains(name) { return this._set.has(name); }
  };
  return el;
}

function createFakeDocument() {
  const body = createFakeElement('body');
  const doc = {
    body,
    activeElement: null,
    createElement(tag) {
      return createFakeElement(tag);
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) { return body.querySelector(sel); },
    querySelectorAll(sel) { return body.querySelectorAll(sel); },
  };
  return doc;
}

// Test: opening the label editor with an initialScientificName should
// include that scientificName on submit even if the user doesn't pick a
// suggestion from the dropdown.

test('label editor preserves initial scientificName when saving without selecting suggestion', async () => {
  const fakeDoc = createFakeDocument();
  const oldDoc = globalThis.document;
  globalThis.document = fakeDoc;
  try {
    // Prepare a minimal player root to host the modal
    const root = fakeDoc.createElement('div');
    root.className = 'player-root';
    fakeDoc.body.appendChild(root);
    const player = {
      root,
      getTagPresets: () => [],
      getLabelEditorSuggestionMode: () => 'merge',
      getLabelTaxonomy: () => [],
      getLabelSuggestions: () => [],
      getLabelEditorSuggestions: () => [],
      _emit: () => {},
    };

    const { openLabelNameEditor } = await import('../src/domain/annotations.ts');

    let received = null;
    openLabelNameEditor({
      player,
      initialValue: 'My bird',
      initialColor: '#112233',
      initialScientificName: 'Turdus merula',
      existingLabels: [],
      title: 'Test',
      onSubmit: (p) => { received = p; },
    });

    // Find the confirm button and trigger its click handler
    const confirm = root.querySelector('.label-search-confirm');
    assert.ok(confirm, 'confirm button should be present');
    // simulate click
    confirm._emit('click');
    // Wait a tick so any modal timeouts/focus scheduling run while our fake
    // document is still active — prevents async activity after the test ends.
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(received, 'onSubmit should have been invoked');
    assert.equal(received.name, 'My bird');
    assert.equal(received.scientificName, 'Turdus merula', 'scientificName must be preserved when not changed');
  } finally {
    globalThis.document = oldDoc;
  }
});
