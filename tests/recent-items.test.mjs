import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecent, loadRecent, saveRecent, recentMenuItems, RECENT_MAX } from '../src/app/recent-items.ts';

function memStore() {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}

test('addRecent: newest first, de-duplicated by kind + path (case/separators ignored)', () => {
    let list = [];
    list = addRecent(list, { kind: 'file', path: 'C:/Feld/a.wav' });
    list = addRecent(list, { kind: 'folder', path: 'C:/Feld', name: 'Feld' });
    list = addRecent(list, { kind: 'file', path: String.raw`c:\Feld\A.WAV` });
    assert.deepEqual(list.map((i) => i.kind), ['file', 'folder']);
    assert.equal(list.length, 2);
    for (let n = 0; n < 20; n++) list = addRecent(list, { kind: 'file', path: `/x/${n}.wav` });
    assert.equal(list.length, RECENT_MAX);
    assert.equal(list[0].path, '/x/19.wav');
});

test('load/save round trip ignores broken data', () => {
    const ls = memStore();
    saveRecent(ls, [{ kind: 'file', path: '/a.wav' }, { kind: 'folder', path: '/p', name: 'p' }]);
    assert.equal(loadRecent(ls).length, 2);
    ls.setItem('signavis.lite.recent.v1', '[{"kind":"file"},{"kind":"evil","path":"/x"},{"kind":"file","path":"/ok.mp3"}]');
    assert.deepEqual(loadRecent(ls), [{ kind: 'file', path: '/ok.mp3' }]);
    ls.setItem('signavis.lite.recent.v1', 'not json');
    assert.deepEqual(loadRecent(ls), []);
    assert.deepEqual(loadRecent(null), []);
});

test('menu labels: folders marked, clashing file names get their folder', () => {
    const items = recentMenuItems([
        { kind: 'file', path: String.raw`D:\Tag1\rec.wav` },
        { kind: 'file', path: '/home/jb/Tag2/rec.wav' },
        { kind: 'folder', path: '/home/jb/Feld 2026', name: 'Feld 2026' },
        { kind: 'file', path: '/home/jb/solo.mp3' },
    ]);
    assert.deepEqual(items.map((i) => i.label), ['rec.wav (Tag1)', 'rec.wav (Tag2)', '📁 Feld 2026', 'solo.mp3']);
    assert.deepEqual(items.map((i) => i.id), ['0', '1', '2', '3']);
});
