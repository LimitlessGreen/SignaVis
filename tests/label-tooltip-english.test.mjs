import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('label tooltips are English in the source (other languages come from the player translation)', () => {
    const src = readFileSync(new URL('../src/domain/annotations.ts', import.meta.url), 'utf8');
    assert.equal(src.includes('[gesperrt]'), false);
    assert.equal((src.match(/ \[read-only\]/g) || []).length, 2);
});
