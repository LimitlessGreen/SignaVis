import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toV3Query, searchXenoCantoRecordings, XC_SEARCH_ENDPOINT } from '../src/infrastructure/xeno-canto/xcSearchApi.ts';

test('toV3Query: free text becomes v3 tags', () => {
    assert.equal(toV3Query('Turdus merula'), 'gen:Turdus sp:merula');
    assert.equal(toV3Query('  Turdus   merula '), 'gen:Turdus sp:merula');
    assert.equal(toV3Query('Turdus'), 'gen:Turdus');
    assert.equal(toV3Query('Common Blackbird'), 'en:"Common Blackbird"');
    assert.equal(toV3Query('blackbird'), 'en:"blackbird"');
});

test('toV3Query: tag queries pass through', () => {
    assert.equal(toV3Query('cnt:Germany grp:birds'), 'cnt:Germany grp:birds');
    assert.equal(toV3Query('gen:Turdus q:A'), 'gen:Turdus q:A');
    assert.equal(toV3Query('Turdus merula q:A'), 'Turdus merula q:A');    assert.equal(toV3Query(''), '');
});

test('searchXenoCantoRecordings: calls v3 with key and tag query', async () => {
    let called = '';
    const fetchImpl = async (url) => {
        called = url;
        return { ok: true, json: async () => ({ numRecordings: '1', numSpecies: '1', page: 1, numPages: 1, recordings: [{ id: '1' }] }) };
    };
    const res = await searchXenoCantoRecordings('Turdus merula', { apiKey: 'k123', fetchImpl });
    const u = new URL(called);
    assert.equal(`${u.origin}${u.pathname}`, XC_SEARCH_ENDPOINT);
    assert.equal(u.searchParams.get('query'), 'gen:Turdus sp:merula');
    assert.equal(u.searchParams.get('key'), 'k123');
    assert.equal(res.recordings.length, 1);
});

test('searchXenoCantoRecordings: no key → clear error, no request', async () => {
    let calls = 0;
    await assert.rejects(
        searchXenoCantoRecordings('Turdus merula', { apiKey: '', fetchImpl: async () => { calls++; } }),
        /API key required/,
    );
    assert.equal(calls, 0);
});

test('searchXenoCantoRecordings: surfaces the v3 error message', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'client_error', message: "Missing or invalid 'key' parameter." }) });
    await assert.rejects(searchXenoCantoRecordings('Turdus', { apiKey: 'bad', fetchImpl }), /invalid 'key'/);
});
