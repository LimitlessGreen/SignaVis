import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionTransportState } from '../src/domain/transportState.ts';

test('allows stable self-transitions', () => {
    assert.equal(canTransitionTransportState('ready', 'ready'), true);
    assert.equal(canTransitionTransportState('playing_segment', 'playing_segment'), true);
});

test('accepts canonical forward transitions', () => {
    assert.equal(canTransitionTransportState('', 'idle'), true);
    assert.equal(canTransitionTransportState('idle', 'loading'), true);
    assert.equal(canTransitionTransportState('loading', 'ready'), true);
    assert.equal(canTransitionTransportState('ready', 'playing'), true);
    assert.equal(canTransitionTransportState('playing', 'paused'), true);
    assert.equal(canTransitionTransportState('paused', 'playing'), true);
    assert.equal(canTransitionTransportState('playing_segment', 'stopped'), true);
    assert.equal(canTransitionTransportState('stopped', 'ready'), true);
});

test('rejects clearly invalid jumps', () => {
    assert.equal(canTransitionTransportState('idle', 'playing'), false);
    assert.equal(canTransitionTransportState('error', 'playing'), false);
    assert.equal(canTransitionTransportState('rendering', 'playing_segment'), false);
    assert.equal(canTransitionTransportState('playing_segment', 'playing_loop'), false);
});

