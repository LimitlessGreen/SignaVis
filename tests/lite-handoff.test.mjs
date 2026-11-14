import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLiteLink, linkTargetFromSearch, isHandoffAvailable, shouldAutoRedirect,
    getAutoOpen, setAutoOpen, getStayInBrowser, setStayInBrowser, openLiteLink,
} from '../src/app/lite-handoff.ts';

test('buildLiteLink: only xc + lang, normalized XC id', () => {
    assert.equal(buildLiteLink({ xc: '1191997', lang: 'de' }), 'signavis://open?xc=XC1191997&lang=de');
    assert.equal(buildLiteLink({ xc: 'xc42' }), 'signavis://open?xc=XC42');
    assert.equal(buildLiteLink({ xc: 'nonsense', lang: '' }), 'signavis://open');
    assert.equal(buildLiteLink(), 'signavis://open');
});

test('linkTargetFromSearch reads the page URL', () => {
    assert.deepEqual(linkTargetFromSearch('?xcid=XC5&lang=fr'), { xc: 'XC5', lang: 'fr' });
    assert.deepEqual(linkTargetFromSearch('?xc=7'), { xc: 'XC7', lang: null });
    assert.deepEqual(linkTargetFromSearch(''), { xc: null, lang: null });
});

test('isHandoffAvailable: desktop browsers only, never inside Lite', () => {
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36';
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18 Safari/605.1.15';
    const linux = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
    const android = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36';
    const ipad = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
    const cros = 'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 Chrome/150 Safari/537.36';
    assert.equal(isHandoffAvailable(win, false), true);
    assert.equal(isHandoffAvailable(mac, false), true);
    assert.equal(isHandoffAvailable(linux, false), true);
    assert.equal(isHandoffAvailable(win, true), false);
    for (const ua of [android, ipad, cros]) assert.equal(isHandoffAvailable(ua, false), false, ua);
});

function memStore() {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('auto-redirect: opt-in, per-tab "stay", ?browser=1', () => {
    const ls = memStore(), ss = memStore();
    assert.equal(getAutoOpen(ls), false);
    setAutoOpen(ls, true);
    assert.equal(getAutoOpen(ls), true);
    assert.equal(shouldAutoRedirect({ autoOpen: getAutoOpen(ls), stay: getStayInBrowser(ss), search: '?xc=1' }), true);
    assert.equal(shouldAutoRedirect({ autoOpen: true, stay: false, search: '?xc=1&browser=1' }), false);
    setStayInBrowser(ss);
    assert.equal(shouldAutoRedirect({ autoOpen: true, stay: getStayInBrowser(ss), search: '' }), false);
    setAutoOpen(ls, false);
    assert.equal(getAutoOpen(ls), false);
    // Storage that throws (privacy mode) counts as "not set"
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
    assert.equal(getAutoOpen(broken), false);
    setAutoOpen(broken, true);
});

function fakeWindow() {
    const listeners = new Map();
    const on = (t, f) => listeners.set(t, [...(listeners.get(t) || []), f]);
    const off = (t, f) => listeners.set(t, (listeners.get(t) || []).filter((g) => g !== f));
    const fire = (t) => (listeners.get(t) || []).forEach((f) => f());
    const win = { location: { href: 'https://example.test/' }, addEventListener: on, removeEventListener: off };
    const doc = { visibilityState: 'visible', addEventListener: on, removeEventListener: off };
    return { win, doc, fire, listeners };
}

test('openLiteLink: blur means an app took the link', async () => {
    const { win, doc, fire } = fakeWindow();
    const p = openLiteLink('signavis://open?xc=XC1', { timeoutMs: 1000, win, doc });
    assert.equal(win.location.href, 'signavis://open?xc=XC1');
    fire('blur');
    assert.equal(await p, true);
});

test('openLiteLink: no reaction within the timeout means not installed', async () => {
    const { win, doc, listeners } = fakeWindow();
    assert.equal(await openLiteLink('signavis://open', { timeoutMs: 20, win, doc }), false);
    assert.equal([...listeners.values()].flat().length, 0, 'listeners removed');
});
