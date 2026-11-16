import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json keeps the BirdNET models out of the npm package', () => {
    assert.ok(Array.isArray(pkg.files), 'package.json `files` must be an array');
    assert.ok(!pkg.files.some((f) => f.replace(/^!/, '').startsWith('models')),
        'models are loaded from a URL (BIRDNET_MODEL_URL), not shipped in the package');
    assert.ok(!Object.keys(pkg.exports).some((k) => k.startsWith('./models')), 'no ./models/* exports');
});
