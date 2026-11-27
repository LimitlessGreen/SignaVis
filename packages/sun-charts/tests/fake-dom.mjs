/* Minimal DOM for node --test: enough for the charts to build their tree without a browser. */
export function fakeEl(tag) {
    const e = {
        tagName: tag, children: [], attrs: {}, style: {}, listeners: {}, textContent: '', className: '', hidden: false,
        set innerHTML(_v) { e.children = []; },
        setAttribute(k, v) { e.attrs[k] = String(v); },
        getAttribute(k) { return e.attrs[k] ?? null; },
        appendChild(c) { e.children.push(c); c.parent = e; return c; },
        append(...cs) { for (const c of cs) if (typeof c === 'object') e.appendChild(c); },
        after(c) { const p = e.parent; if (p) { p.children.splice(p.children.indexOf(e) + 1, 0, c); c.parent = p; } },
        get firstElementChild() { return e.children[0] ?? null; },
        get childElementCount() { return e.children.length; },
        prepend(c) { e.children.unshift(c); c.parent = e; },
        value: '',
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
export function installFakeDom() {
    globalThis.document = { createElement: fakeEl, createElementNS: (_ns, tag) => fakeEl(tag) };
}

/** Depth-first search over the fake tree. */
export function find(el, pred) {
    if (pred(el)) return el;
    for (const c of el.children || []) { const r = find(c, pred); if (r) return r; }
    return null;
}

/** All nodes matching `pred`. */
export function findAll(el, pred, out = []) {
    if (pred(el)) out.push(el);
    for (const c of el.children || []) findAll(c, pred, out);
    return out;
}

/** All text in the tree, joined. */
export const allText = (el) => findAll(el, () => true).map((n) => (typeof n.textContent === 'string' ? n.textContent : '')).join(' | ');
