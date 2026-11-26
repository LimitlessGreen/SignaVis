import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM: enough for SunCharts to build its tree without a browser.
function fakeEl(tag) {
    const e = {
        tagName: tag, children: [], attrs: {}, style: {}, listeners: {}, textContent: '', className: '', hidden: false,
        set innerHTML(_v) { e.children = []; },
        setAttribute(k, v) { e.attrs[k] = String(v); },
        getAttribute(k) { return e.attrs[k] ?? null; },
        appendChild(c) { e.children.push(c); c.parent = e; return c; },
        append(...cs) { for (const c of cs) if (typeof c === 'object') e.appendChild(c); },
        after(c) { const p = e.parent; if (p) { p.children.splice(p.children.indexOf(e) + 1, 0, c); c.parent = p; } },
        get firstElementChild() { return e.children[0] ?? null; },
        addEventListener(type, fn) { (e.listeners[type] ||= []).push(fn); },
        getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector(sel) {
            const cls = sel.replace(/^\./, '');
            const walk = (n) => { for (const c of n.children) { if (String(c.className).split(' ').includes(cls) || c.attrs.class === cls) return c; const r = walk(c); if (r) return r; } return null; };
            return walk(e);
        },
    };
    // Anything else the charts touch (prepend, dataset, …) is a no-op function.
    return new Proxy(e, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? (t[k] = () => {}) : undefined) });
}
globalThis.document = { createElement: fakeEl, createElementNS: (_ns, tag) => fakeEl(tag) };

const { SunCharts } = await import('../src/index.ts');

function find(el, pred) {
    if (pred(el)) return el;
    for (const c of el.children || []) { const r = find(c, pred); if (r) return r; }
    return null;
}

test('SunCharts reads and writes the view choice through the given storage', () => {
    const store = new Map([['my.view', 'dial']]);
    const storage = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) };
    const charts = new SunCharts({ storage, storageKey: 'my.view' });
    charts.render({ lat: 51.34, lon: 12.37 }, '2026-11-20', '07:30');
    assert.ok(find(charts.el, (e) => e.className === 'sun-dials'), 'dial view taken from storage');

    const chartBtn = find(charts.el, (e) => e.tagName === 'button' && e.textContent === 'Chart');
    chartBtn.listeners.click[0]();
    assert.equal(store.get('my.view'), 'chart');
    assert.ok(find(charts.el, (e) => e.className === 'sun-lines'), 're-rendered as charts');
});

test('SunCharts hides itself without date or place', () => {
    const charts = new SunCharts({ storage: { get: () => null, set() {} } });
    charts.render(null, '2026-11-20', null);
    assert.equal(charts.el.hidden, true);
});
