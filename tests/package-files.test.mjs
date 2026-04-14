import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package.json includes models directory in files', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(Array.isArray(pkg.files), 'package.json `files` must be an array');
    assert.ok(pkg.files.includes('models/'), 'package.json `files` should include "models/"');
});
