import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isTauri, isLite, isFullDesktop, vendorUrl } from '../src/infrastructure/tauri/runtime.ts';

const CDN = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const g = globalThis;

afterEach(() => {
    delete g.__TAURI_INTERNALS__;
    delete g.__SIGNAVIS_LITE__;
    delete g.location;
});

test('browser: no shell, CDN URLs', () => {
    assert.equal(isTauri(), false);
    assert.equal(isLite(), false);
    assert.equal(isFullDesktop(), false);
    assert.equal(vendorUrl('leaflet/leaflet.js', CDN), CDN);
});

test('full desktop: Tauri without the Lite marker', () => {
    g.__TAURI_INTERNALS__ = {};
    assert.equal(isTauri(), true);
    assert.equal(isLite(), false);
    assert.equal(isFullDesktop(), true);
    assert.equal(vendorUrl('leaflet/leaflet.js', CDN), CDN);
});

test('Lite: marker set, vendor files served from the app root', () => {
    g.__TAURI_INTERNALS__ = {};
    g.__SIGNAVIS_LITE__ = { version: '1.0.5' };
    g.location = { href: 'http://tauri.localhost/demo/labeling-app.html?xc=1' };
    assert.equal(isLite(), true);
    assert.equal(isFullDesktop(), false);
    assert.equal(vendorUrl('leaflet/leaflet.js', CDN), 'http://tauri.localhost/vendor/leaflet/leaflet.js');
});

test('Lite marker alone (no Tauri IPC) does not count as Lite', () => {
    g.__SIGNAVIS_LITE__ = { version: '1.0.5' };
    assert.equal(isLite(), false);
});
