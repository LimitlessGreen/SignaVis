import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXcQuery, toXcRef, refineRefs, searchXcRefs, parseXcLength, distanceKm, boxAround, licenceLabel, DEFAULT_FILTERS }
    from '../src/app/xc-reference.ts';

const home = { lat: 51.0, lon: 10.0 };

test('query carries species, type, quality, length and a box around the location', () => {
    const q = decodeURIComponent(buildXcQuery('Glaucidium passerinum', { ...DEFAULT_FILTERS, nearKm: 300 }, home));
    assert.match(q, /^gen:Glaucidium\+sp:passerinum\+type:"song"\+q:">C"\+len:"<60"\+box:/);
    const [la0, lo0, la1, lo1] = q.split('box:')[1].split(',').map(Number);
    assert.ok(la0 < 51 && la1 > 51 && lo0 < 10 && lo1 > 10);
    // ~300 km north-south
    assert.ok(Math.abs(distanceKm({ lat: la0, lon: 10 }, { lat: la1, lon: 10 }) - 600) < 5);
});

test('world, any quality, any length: only the species', () => {
    const f = { type: '', quality: 'any', maxLenS: 0, nearKm: 0, sameSeason: false };
    assert.equal(buildXcQuery('Strix aluco', f, home), 'gen:Strix+sp:aluco');
    assert.equal(buildXcQuery('Strix aluco', { ...f, nearKm: 500 }, null), 'gen:Strix+sp:aluco');
});

test('box stays inside the globe near the pole', () => {
    const [la0, , la1] = boxAround({ lat: 89, lon: 0 }, 500);
    assert.ok(la0 >= -90 && la1 <= 90);
});

test('API recording → tile data', () => {
    const r = toXcRef({ id: 912340, type: ' song ', q: 'A', len: '0:42', cnt: 'Norway', rec: 'T. Example', date: '2024-03-11',
        lat: '60.1', lon: '10.7', lic: '//creativecommons.org/licenses/by-nc-sa/4.0/', sono: { small: '//xc/s.png', med: '//xc/m.png' } }, home);
    assert.equal(r.id, '912340');
    assert.equal(r.type, 'song');
    assert.equal(r.lenS, 42);
    assert.equal(r.month, 3);
    assert.equal(r.licence, 'CC BY-NC-SA 4.0');
    assert.equal(r.sono, 'https://xc/m.png');
    assert.ok(r.distKm > 950 && r.distKm < 1050);
    assert.equal(toXcRef({ id: 1 }, home).distKm, null);
});

test('length and licence parsing', () => {
    assert.equal(parseXcLength('1:02:03'), 3723);
    assert.equal(parseXcLength('x'), 0);
    assert.equal(licenceLabel('https://creativecommons.org/publicdomain/zero/1.0/'), 'CC0');
    assert.equal(licenceLabel(''), '');
});

test('refine: exact radius, same season, quality sort', () => {
    const r = (id, q, distKm, month, lenS = 10) => ({ id, q, distKm, month, lenS });
    const list = [r('far', 'A', 900, 3), r('b', 'B', 50, 3), r('a', 'A', 200, 3), r('aut', 'A', 10, 9), r('nogeo', 'C', null, null)];
    const f = { ...DEFAULT_FILTERS, nearKm: 500, sameSeason: true };
    assert.deepEqual(refineRefs(list, f, { month: 4 }).map((x) => x.id), ['a', 'b', 'nogeo']);
    assert.deepEqual(refineRefs(list, { ...f, sameSeason: false }, { sort: 'distance' }).map((x) => x.id), ['aut', 'b', 'a', 'nogeo']);
    // Dec ↔ Jan are neighbours
    assert.deepEqual(refineRefs([r('jan', 'A', 1, 1)], f, { month: 12 }).map((x) => x.id), ['jan']);
});

test('search tries the next name when the first finds nothing', async () => {
    const seen = [];
    const res = await searchXcRefs(['Aegolius funereus', 'Aegolius funereus magnus'], DEFAULT_FILTERS, null, async (q) => {
        seen.push(q);
        return seen.length === 1 ? { recordings: [], numRecordings: 0, numPages: 0 } : { recordings: [{ id: 5 }], numRecordings: 1, numPages: 1 };
    });
    assert.equal(seen.length, 2);
    assert.equal(res.name, 'Aegolius funereus magnus');
    assert.deepEqual(res.refs.map((x) => x.id), ['5']);
});

test('similarity order: ranked first, the rest keep their order', async () => {
    const { bySimilarity } = await import('../src/app/xc-reference.ts');
    const list = [{ id: 'a' }, { id: 'b', sim: 0.4 }, { id: 'c' }, { id: 'd', sim: 0.9 }];
    assert.deepEqual(bySimilarity(list).map((x) => x.id), ['d', 'b', 'a', 'c']);
});

test('box across the antimeridian takes every longitude', () => {
    const [, lo0, , lo1] = boxAround({ lat: 0, lon: 179 }, 500);
    assert.deepEqual([lo0, lo1], [-180, 180]);
    const [, a, , b] = boxAround({ lat: 0, lon: 10 }, 500);
    assert.ok(a > 5 && b < 15);
});
