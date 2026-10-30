import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLicenseValue } from '../src/ui/panels/xc-panel.ts';

test('normalizeLicenseValue: XC codes with version, free-form input accepted', () => {
    assert.equal(normalizeLicenseValue('CC BY-NC-SA 4.0'), 'CC-BY-NC-SA-4.0');
    assert.equal(normalizeLicenseValue('CC-BY-NC-SA'), 'CC-BY-NC-SA-4.0');
    assert.equal(normalizeLicenseValue('CC-BY-4.0'), 'CC-BY-4.0');
    assert.equal(normalizeLicenseValue('cc-by-nc-nd'), 'CC-BY-NC-ND-4.0');
    assert.equal(normalizeLicenseValue('CC0'), 'CC0');
    assert.equal(normalizeLicenseValue(''), '');
    assert.equal(normalizeLicenseValue('all rights reserved'), '');
});
