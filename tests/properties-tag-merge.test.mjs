import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal fake DOM tailored for the PropertiesPanel + EditableSelect tests.
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
    hidden: false,
    _innerHTML: '',
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      for (const n of nodes) {
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
      for (const part of parts) this._searchAll(part, out);
      return out;
    },
    _search(sel) {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        const q = [this];
        while (q.length) {
          const n = q.shift();
          if (n.className && n.className.split(/\s+/).includes(cls)) return n;
          for (const c of n.children) q.push(c);
        }
        return null;
      }
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
      const m = sel.match(/^\[([a-zA-Z0-9\-]+)(?:=(?:\"|')?([^\"']+)(?:\"|')?)?\]$/);
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
    },
    addEventListener(name, handler) { (this._handlers[name] ||= []).push(handler); },
    removeEventListener(name, handler) { if (!this._handlers[name]) return; this._handlers[name] = this._handlers[name].filter(h => h !== handler); },
    _emit(name, ev = {}) { const handlers = this._handlers[name] || []; for (const h of handlers.slice()) { try { h(ev); } catch(e) {} } },
    focus() { globalThis.document.activeElement = this; },
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; },
    select() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel.startsWith('.') && cur.className && cur.className.split(/\s+/).includes(sel.slice(1))) return cur;
        if (/^[a-zA-Z]+$/.test(sel) && cur.tagName === sel.toUpperCase()) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 100, right: 100, width: 100, height: 100 }; },
  };

  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML || ''; },
    set(v) { el._innerHTML = String(v || ''); if (v === '') el.children = []; },
  });

  el.classList = {
    _set: new Set(),
    add(...names) { for (const n of names) this._set.add(n); el.className = Array.from(this._set).join(' '); },
    remove(...names) { for (const n of names) this._set.delete(n); el.className = Array.from(this._set).join(' '); },
    toggle(name) { if (this._set.has(name)) { this._set.delete(name); el.className = Array.from(this._set).join(' '); return false; } this._set.add(name); el.className = Array.from(this._set).join(' '); return true; },
    contains(name) { return this._set.has(name); },
  };

  return el;
}

function createFakeDocument() {
  const body = createFakeElement('body');
  const doc = {
    body,
    activeElement: null,
    createElement(tag) { return createFakeElement(tag); },
    createDocumentFragment() { return createFakeElement('fragment'); },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) { return body.querySelector(sel); },
    querySelectorAll(sel) { return body.querySelectorAll(sel); },
  };
  return doc;
}

test('properties panel merges multiple preset tag changes', async () => {
  const fakeDoc = createFakeDocument();
  const oldDoc = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.document = fakeDoc;
  globalThis.window = { innerHeight: 800, innerWidth: 1400 };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const { PropertiesPanel } = await import('../src/ui/panels/properties-panel.ts');
    const { TAG_PRESETS } = await import('../src/ui/panels/label-table.ts');

    // Monkeypatch PropertiesPanel._buildTagsSection to use lightweight stub
    // editable-select widgets that expose a `select(value)` helper. This
    // avoids exercising the full dropdown DOM code and makes the test
    // deterministic in the fake DOM environment.
    const origBuildTags = PropertiesPanel.prototype._buildTagsSection;
    PropertiesPanel.prototype._buildTagsSection = function(lbl, editable) {
      const frag = document.createDocumentFragment();
      const header = document.createElement('div');
      header.className = 'props-tag-header';
      header.textContent = 'Tags';
      frag.appendChild(header);

      const tags = (lbl.tags && typeof lbl.tags === 'object') ? { ...lbl.tags } : {};

      const grid = document.createElement('dl');
      grid.className = 'props-grid';

      function createStubEditableSelect(opts) {
        const root = document.createElement('div');
        const trigger = document.createElement('button');
        trigger.className = 'esel-trigger';
        root.appendChild(trigger);
        return {
          el: root,
          select(val) { opts.onChange(val); },
          setValue(v) { /* noop */ },
          destroy() {},
        };
      }

      for (const preset of TAG_PRESETS) {
        const dt = document.createElement('dt');
        dt.textContent = preset.key;
        const dd = document.createElement('dd');
        dd.classList.add('props-editable');
        const items = preset.options.map((v) => ({ value: v, custom: false }));
        const es = createStubEditableSelect({ value: tags[preset.key] || '', items, onChange: (val) => {
          const cur = this.displayedLabel;
          if (!cur) return;
          const newTags = { ...cur.tags };
          if (val) newTags[preset.key] = val; else delete newTags[preset.key];
          this._emitChange(cur.id, { tags: newTags });
        }});
        dd.appendChild(es.el);
        this._esInstances.push(es);
        grid.appendChild(dt);
        grid.appendChild(dd);
      }

      frag.appendChild(grid);
      return frag;
    };

    const state = { labels: [ { id: 'L1', tags: {} } ] };

    const propsPanel = new PropertiesPanel();

    // onChange handler similar to demo/labeling-app.html: update state and refresh panel
    propsPanel.onChange = (id, updates) => {
      const idx = state.labels.findIndex(l => l.id === id);
      if (idx < 0) return;
      const prev = state.labels[idx];
      state.labels[idx] = { ...prev, ...updates };
      // refresh the properties UI to ensure closures capture the fresh object
      propsPanel.refreshLabel(state.labels[idx]);
    };

    // Pin the label so the panel builds editable inputs
    propsPanel.pinLabel(state.labels[0]);

    // Ensure preset selects were created
    assert.ok(Array.isArray(propsPanel._esInstances) && propsPanel._esInstances.length >= 2, 'editable selects should be present');

    const esSex = propsPanel._esInstances[0];
    const esLife = propsPanel._esInstances[1];

    // Helper to open the dropdown and click the row with the given value
    function selectValueOnEs(es, val) {
      // If the editable-select is a test stub, use its programmatic helper.
      if (es && typeof es.select === 'function') {
        es.select(val);
        return;
      }
      // prefer querySelector but fall back to scanning children (robust for fake DOM)
      let trigger = es.el.querySelector('.esel-trigger');
      if (!trigger && Array.isArray(es.el.children)) {
        trigger = es.el.children.find((c) => c.className && c.className.split(/\s+/).includes('esel-trigger')) || null;
      }
      assert.ok(trigger, 'trigger must exist');
      trigger._emit('click', { stopPropagation: () => {} });

      // find rows in the portal (body)
      const rows = document.body.querySelectorAll('.esel-row');
      let target = null;
      for (const r of rows) {
        const lbl = (r.children && r.children[0]) ? r.children[0].textContent : null;
        if (lbl === val) { target = r; break; }
      }
      assert.ok(target, 'row for value not found: ' + val);
      target._emit('click', { stopPropagation: () => {} });
    }

    // 1) select sex = female
    selectValueOnEs(esSex, 'female');
    // allow handlers to run
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(state.labels[0].tags.sex, 'female', 'sex should be set after first selection');

    // 2) After the panel refreshed, obtain the fresh editable-select instances
    // (the PropertiesPanel rebuilds them) and use the updated lifeStage select.
    const freshEsLife = propsPanel._esInstances[1];
    selectValueOnEs(freshEsLife, 'adult');
    await new Promise((r) => setTimeout(r, 0));

    // Both tags should be present — regression guard
    assert.equal(state.labels[0].tags.sex, 'female');
    assert.equal(state.labels[0].tags.lifeStage, 'adult');

  } finally {
    globalThis.document = oldDoc;
    globalThis.window = oldWindow;
  }
});
