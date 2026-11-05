import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAVIS_VERSION, softwareNameAndVersion } from '../src/version.ts';

test('unbundled source reports dev version', () => {
  assert.equal(SIGNAVIS_VERSION, 'dev');
  assert.equal(softwareNameAndVersion(), 'SignaVis dev');
});

test('explicit override wins over build version', () => {
  assert.equal(softwareNameAndVersion('2.0.0'), 'SignaVis 2.0.0');
  assert.equal(softwareNameAndVersion('  '), 'SignaVis dev');
});
