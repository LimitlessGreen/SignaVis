import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('README mentions wavesurfer peer dependency or CDN', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.ok(/wavesurfer/i.test(readme), 'README should mention "wavesurfer"');
    // also check for CDN or explicit peer-dep wording (loose match)
    assert.ok(/cdn|unpkg|peer[- ]?dep|wavesurfer\.js/i.test(readme), 'README should reference peer dependency or CDN for wavesurfer');
});
