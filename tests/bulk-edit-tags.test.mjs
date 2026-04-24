import test from 'node:test';
import assert from 'node:assert/strict';

// Reuse minimal fake DOM from label-editor test
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
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) { if (typeof n === 'string') { const t = { tagName: '#text', textContent: n, parentNode: null }; this.appendChild(t); } else this.appendChild(n); } },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i,1); child.parentNode = null; return child; },
    querySelector(selector) { if (!selector) return null; const parts = selector.split(',').map(s=>s.trim()); for (const part of parts) { const f = this._search(part); if (f) return f; } return null; },
    querySelectorAll(selector) { const out = []; const parts = selector.split(',').map(s=>s.trim()); for (const p of parts) this._searchAll(p, out); return out; },
    _search(sel) { if (sel.startsWith('.')) { const cls = sel.slice(1); const q=[this]; while(q.length){ const n=q.shift(); if(n.className && n.className.split(/\s+/).includes(cls)) return n; for(const c of n.children) q.push(c);} return null; } if(/^[a-zA-Z]+$/.test(sel)){ const tag=sel.toUpperCase(); const q=[this]; while(q.length){ const n=q.shift(); if(n.tagName===tag) return n; for(const c of n.children) q.push(c);} return null; } const m=sel.match(/^\[([a-zA-Z0-9\-]+)(?:=(?:\"|')?([^\"']+)(?:\"|')?)?\]$/); if(m){ const attr=m[1]; const val=m[2]; const q=[this]; while(q.length){ const n=q.shift(); if(typeof n[attr] !== 'undefined'){ if(!val) return n; if(String(n[attr])===val) return n; } for(const c of n.children) q.push(c);} return null;} return null; },
    _searchAll(sel,out){ if(sel.startsWith('.')){ const cls=sel.slice(1); const q=[this]; while(q.length){ const n=q.shift(); if(n.className && n.className.split(/\s+/).includes(cls)) out.push(n); for(const c of n.children) q.push(c); } return; } },
    addEventListener(name, handler){ (this._handlers[name] ||= []).push(handler); },
    removeEventListener(name, handler){ if(!this._handlers[name]) return; this._handlers[name] = this._handlers[name].filter(h=>h!==handler); },
    _emit(name, ev={}){ const handlers = this._handlers[name]||[]; for(const h of handlers.slice()){ try{ h(ev); }catch(e){} } },
    focus(){ globalThis.document.activeElement = this; },
    blur(){ if(globalThis.document.activeElement===this) globalThis.document.activeElement = null; },
    select(){},
    setAttribute(k,v){ this[k]=v; },
    getAttribute(k){ return this[k]; },
    closest(sel){ let cur=this; while(cur){ if(sel.startsWith('.') && cur.className && cur.className.split(/\s+/).includes(sel.slice(1))) return cur; if(/^[a-zA-Z]+$/.test(sel) && cur.tagName===sel.toUpperCase()) return cur; cur=cur.parentNode; } return null; },
    getBoundingClientRect(){ return { left:0, top:0, bottom:100, right:100, width:100, height:100 }; }
  };

  Object.defineProperty(el, 'innerHTML', { get(){ return el._innerHTML || ''; }, set(v){ el._innerHTML = String(v||''); if(v==='') el.children = []; } });

  el.classList = {
    _set: new Set(),
    add(...names){ for(const n of names) this._set.add(n); el.className = Array.from(this._set).join(' '); },
    remove(...names){ for(const n of names) this._set.delete(n); el.className = Array.from(this._set).join(' '); },
    toggle(name){ if(this._set.has(name)){ this._set.delete(name); el.className = Array.from(this._set).join(' '); return false; } this._set.add(name); el.className = Array.from(this._set).join(' '); return true; },
    contains(name){ return this._set.has(name); }
  };

  return el;
}

function createFakeDocument(){ const body = createFakeElement('body'); const doc = { body, activeElement: null, createElement(tag){ return createFakeElement(tag); }, createDocumentFragment(){ return createFakeElement('fragment'); }, addEventListener(){}, removeEventListener(){}, querySelector(sel){ return body.querySelector(sel); }, querySelectorAll(sel){ return body.querySelectorAll(sel); } }; return doc; }

test('bulk rename applies tags to whole group', async () => {
  const fakeDoc = createFakeDocument();
  const oldDoc = globalThis.document;
  globalThis.document = fakeDoc;
  try {
    const root = fakeDoc.createElement('div'); root.className = 'player-root'; fakeDoc.body.appendChild(root);
    const player = { root, _emit: () => {}, getTagPresets: () => [] };

    const { SpectrogramLabelLayer } = await import('../src/domain/annotations.ts');
    const layer = new SpectrogramLabelLayer();
    layer.player = player;
    layer.overlay = root;

    // Two labels with different tags initially
    layer._items = [
      { id: 'L1', label: 'One', color: '#112233', tags: { sex: 'male' }, scientificName: '' },
      { id: 'L2', label: 'Two', color: '#445566', tags: { lifeStage: 'juvenile' }, scientificName: '' },
    ];

    // Trigger bulk prompt for both labels
    layer._renameBulkPrompt(['L1','L2']);

    // Confirm button should be in the player's root (openLabelNameEditor attaches to player.root)
    const confirm = root.querySelector('.label-search-confirm');
    assert.ok(confirm, 'confirm button should be present');
    // Click Save without changing anything — initialTags should be taken from first label
    confirm._emit('click');
    await new Promise(r => setTimeout(r, 0));

    // Both labels should now have tags equal to first label's tags (overwritten)
    assert.deepEqual(layer._items[0].tags, { sex: 'male' });
    assert.deepEqual(layer._items[1].tags, { sex: 'male' });
  } finally {
    globalThis.document = oldDoc;
  }
});
