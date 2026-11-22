// keymap.test.mjs — one dispatcher decides which shortcut gets a key (shared/keymap.ts)

import test from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, dispatchKey } from '../src/shared/keymap.ts';

const el = (tagName, extra = {}, parent = null) => ({
    tagName, isContentEditable: false, parent, ...extra,
    closest(sel) {
        for (let n = this; n; n = n.parent) {
            for (const s of sel.split(',').map((x) => x.trim())) {
                if (s === '[data-aw-own-keys]' && n.ownKeys) return n;
                if (s === 'a[href]' && n.tagName === 'A' && n.href) return n;
                if (/^[a-z]+$/.test(s) && n.tagName === s.toUpperCase()) return n;
            }
        }
        return null;
    },
});
const key = (k, target = el('BODY'), defaultPrevented = false) => ({
    key: k, target, defaultPrevented,
    preventDefault() { this.defaultPrevented = true; },
});
const noModal = () => false;

test('skipReason: handled, typing, own keys, Enter on controls, modal', () => {
    assert.equal(skipReason(key(' ', el('BODY'), true), noModal), 'handled');
    assert.equal(skipReason(key(' ', el('INPUT', { type: 'text' })), noModal), 'typing');
    assert.equal(skipReason(key('ArrowDown', el('SELECT')), noModal), 'typing');
    assert.equal(skipReason(key(' ', el('SPAN', {}, el('DIV', { ownKeys: true }))), noModal), 'own-keys');
    assert.equal(skipReason(key('Enter', el('SPAN', {}, el('BUTTON'))), noModal), 'control');
    assert.equal(skipReason(key(' ', el('BODY')), () => true), 'modal');
});

test('skipReason: Space on a focused button or select still goes to the shortcuts', () => {
    assert.equal(skipReason(key(' ', el('BUTTON')), noModal), null);
    assert.equal(skipReason(key(' ', el('SELECT')), noModal), null);
    assert.equal(skipReason(key('Enter', el('DIV')), noModal), null);
});

test('dispatchKey: scope order review → label → player → app, first claim wins', () => {
    const log = [];
    const h = (scope, claim) => ({ scope, run: (e) => { log.push(scope); if (claim) e.preventDefault(); } });
    const handlers = [h('app', true), h('player', true), h('label', false), h('review', false)];
    const won = dispatchKey(key(' '), handlers);
    assert.equal(won.scope, 'player');
    assert.deepEqual(log, ['review', 'label', 'player']);
});

test('dispatchKey: nobody claims → null, all ran once', () => {
    const log = [];
    const handlers = ['app', 'review'].map((scope) => ({ scope, run: () => log.push(scope) }));
    assert.equal(dispatchKey(key('q'), handlers), null);
    assert.deepEqual(log, ['review', 'app']);
});

test('dispatchKey: within a scope, registration order', () => {
    const log = [];
    const handlers = [1, 2].map((n) => ({ scope: 'label', run: (e) => { log.push(n); e.preventDefault(); } }));
    dispatchKey(key('x'), handlers);
    assert.deepEqual(log, [1]);
});
