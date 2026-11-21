// typing-context.test.mjs — which focused elements keep a key from the player shortcuts (shared/utils.ts)

import test from 'node:test';
import assert from 'node:assert/strict';
import { isTypingContext } from '../src/shared/utils.ts';

const el = (tagName, extra = {}) => ({ tagName, isContentEditable: false, ...extra });

test('text entry keeps every key', () => {
    for (const t of [el('INPUT'), el('INPUT', { type: 'text' }), el('INPUT', { type: 'number' }),
        el('INPUT', { type: 'search' }), el('TEXTAREA'), el('DIV', { isContentEditable: true })]) {
        assert.equal(isTypingContext(t, ' '), true);
        assert.equal(isTypingContext(t, 'ArrowLeft'), true);
    }
});

test('a focused dropdown leaves Space/Home/End/J/L to the player, keeps its arrows', () => {
    const sel = el('SELECT');
    for (const k of [' ', 'Home', 'End', 'j', 'l']) assert.equal(isTypingContext(sel, k), false, k);
    assert.equal(isTypingContext(sel, 'ArrowDown'), true);
});

test('a slider keeps arrows and Home/End, not Space', () => {
    const r = el('INPUT', { type: 'range' });
    assert.equal(isTypingContext(r, ' '), false);
    assert.equal(isTypingContext(r, 'ArrowRight'), true);
    assert.equal(isTypingContext(r, 'Home'), true);
});

test('buttons and checkboxes keep nothing', () => {
    for (const t of [el('BUTTON'), el('INPUT', { type: 'checkbox' }), el('INPUT', { type: 'button' })]) {
        assert.equal(isTypingContext(t, ' '), false);
        assert.equal(isTypingContext(t, 'ArrowLeft'), false);
    }
});

test('null / non-elements are not typing', () => {
    assert.equal(isTypingContext(null, ' '), false);
    assert.equal(isTypingContext({}, ' '), false);
});
