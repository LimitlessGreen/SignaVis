import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, checkArgs } from '../src/app/lite/assistant-tools.ts';

const reg = (confirm = async () => true) => new ToolRegistry({ confirm });

test('assistant tools: argument check covers types, required, enum, ranges, unknown keys', () => {
  const s = { type: 'object', additionalProperties: false, required: ['start'],
    properties: { start: { type: 'number', minimum: 0 }, kind: { enum: ['a', 'b'] }, ids: { type: 'array', items: { type: 'string' } } } };
  assert.deepEqual(checkArgs(s, { start: 1 }), []);
  assert.deepEqual(checkArgs(s, { start: 2, ids: ['x'] }), []);
  assert.match(checkArgs(s, {})[0], /start is required/);
  assert.match(checkArgs(s, { start: -1 })[0], /≥ 0/);
  assert.match(checkArgs(s, { start: 'x' })[0], /must be number/);
  assert.match(checkArgs(s, { start: 1, kind: 'c' })[0], /one of/);
  assert.match(checkArgs(s, { start: 1, ids: [3] })[0], /ids\[0\] must be string/);
  assert.match(checkArgs(s, { start: 1, foo: 1 })[0], /foo is not a known/);
  // integers are numbers
  assert.deepEqual(checkArgs({ type: 'number' }, 3), []);
});

test('assistant tools: list has the MCP shape with hints by tier', () => {
  const r = reg()
    .add({ name: 'get_state', description: 'd', tier: 'read', run: () => ({}) })
    .add({ name: 'delete_labels', description: 'd', tier: 'destructive', input: { properties: { ids: { type: 'array' } } }, run: () => {} });
  const [a, b] = r.list();
  assert.deepEqual(a.inputSchema, { type: 'object', properties: {} });
  assert.deepEqual(a.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  assert.equal(b.annotations.destructiveHint, true);
  assert.equal(b.inputSchema.type, 'object');
  assert.throws(() => r.add({ name: 'bad name', description: '', tier: 'read', run: () => {} }));
});

test('assistant tools: results become text + structuredContent; errors never throw', async () => {
  const r = reg()
    .add({ name: 'obj', description: '', tier: 'read', run: () => ({ n: 2 }) })
    .add({ name: 'arr', description: '', tier: 'read', run: () => [1, 2] })
    .add({ name: 'str', description: '', tier: 'read', run: () => 'hi' })
    .add({ name: 'boom', description: '', tier: 'write', run: () => { throw new Error('no recording open'); } })
    .add({ name: 'img', description: '', tier: 'read', run: () => ({ content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] }) })
    .add({ name: 'need', description: '', tier: 'read', input: { required: ['x'], properties: { x: { type: 'string' } } }, run: () => 'ok' });
  const o = await r.call('obj');
  assert.deepEqual(o.structuredContent, { n: 2 });
  assert.deepEqual(JSON.parse(o.content[0].text), { n: 2 });
  assert.deepEqual((await r.call('arr')).structuredContent, { items: [1, 2] });
  assert.deepEqual(await r.call('str'), { content: [{ type: 'text', text: 'hi' }] });
  const e = await r.call('boom');
  assert.equal(e.isError, true);
  assert.match(e.content[0].text, /no recording open/);
  assert.equal((await r.call('img')).content[0].type, 'image');
  assert.equal((await r.call('nope')).isError, true);
  const bad = await r.call('need', {});
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /x is required/);
  assert.equal((await r.call('need', { x: 'a' })).content[0].text, 'ok');
  assert.deepEqual(r.log.map((l) => [l.name, l.ok]), [['obj', true], ['arr', true], ['str', true], ['boom', false], ['img', true], ['need', false], ['need', true]]);
});

test('assistant tools: destructive tools ask first; declining does not run them', async () => {
  let ran = 0;
  let asked = '';
  const def = { name: 'del', description: '', tier: 'destructive', confirmText: (a) => `Delete ${a.ids.length} labels?`, run: () => { ran++; return 'deleted'; } };
  const no = reg(async (q) => { asked = q; return false; }).add(def);
  const res = await no.call('del', { ids: [1, 2] });
  assert.equal(res.isError, true);
  assert.equal(ran, 0);
  assert.equal(asked, 'Delete 2 labels?');
  const yes = reg(async () => true).add(def);
  assert.equal((await yes.call('del', { ids: [1] })).content[0].text, 'deleted');
  assert.equal(ran, 1);
});

// ── app tools on a fake app ──
import { buildAppTools, filterLabels } from '../src/app/lite/assistant-app-tools.ts';

function fakeApp() {
  const calls = [];
  let labels = [
    { id: 'a', start: 1, end: 2, label: 'Tengmalm\'s Owl', scientificName: 'Aegolius funereus', freqMin: 500, freqMax: 900 },
    { id: 'b', start: 5, end: 8, label: 'Robin', origin: 'birdnet', confidence: 0.42 },
  ];
  const app = {
    calls,
    state: () => ({ recording: 'x.wav' }),
    recordings: async (q) => [{ id: 'r1', name: q }],
    openRecording: async (id) => calls.push(['open', id]),
    labels: () => labels,
    labelsReady: () => true,
    addLabels: (list, s) => { calls.push(['add', s]); const ids = list.map((_, i) => `n${i}`); labels = [...labels, ...list.map((l, i) => ({ ...l, label: l.species, id: ids[i] }))]; return ids; },
    updateLabels: (ch, s) => { calls.push(['upd', s, ch]); return ch.length; },
    deleteLabels: (ids, s) => { calls.push(['del', s]); return ids.length; },
    view: () => ({ duration: 60, time: 0, start: 0, end: 60 }),
    seek: (t) => calls.push(['seek', t]),
    zoom: (a, b) => calls.push(['zoom', a, b]),
    species: () => [{ name: 'Robin', scientificName: 'Erithacus rubecula' }],
    actions: () => [{ id: 'space:review', group: 'actions', label: 'Go to Review', sub: 'space' }, { id: 'project:new-session', group: 'actions', label: 'New session' }],
    runAction: (id) => calls.push(['action', id]),
    runBirdnet: async () => ({ ok: true, added: 1 }),
    canBirdnet: () => true,
    spectrogramPng: async (w, withLabels) => { calls.push(['png', w, withLabels]); return 'AA=='; },
  };
  return app;
}

test('app tools: labels filter by species, time, origin and confidence', () => {
  const all = fakeApp().labels();
  assert.deepEqual(filterLabels(all, { species: 'aegolius' }).map((l) => l.id), ['a']);
  assert.deepEqual(filterLabels(all, { from: 3 }).map((l) => l.id), ['b']);
  assert.deepEqual(filterLabels(all, { origin: 'manual' }).map((l) => l.id), ['a']);
  assert.deepEqual(filterLabels(all, { minConfidence: 0.5 }).map((l) => l.id), ['a']);
});

test('app tools: add checks ranges, clamps to the recording and is one undo step', async () => {
  const app = fakeApp();
  const r = buildAppTools(app, { confirm: async () => true });
  const ok = await r.call('add_labels', { labels: [{ start: 10, end: 99, species: 'Robin' }, { start: 3, end: 4, species: 'Robin', freqMin: 2000, freqMax: 4000 }] });
  assert.deepEqual(ok.structuredContent, { added: 2, ids: ['n0', 'n1'] });
  assert.deepEqual(app.calls.filter((c) => c[0] === 'add'), [['add', 'AI: added 2 labels']]);
  assert.equal(app.labels().find((l) => l.id === 'n0').end, 60);
  for (const bad of [{ start: 5, end: 4 }, { start: 61, end: 62 }, { start: 1, end: 2, freqMin: 100 }, { start: 1, end: 2, freqMin: 900, freqMax: 100 }]) {
    const res = await r.call('add_labels', { labels: [{ species: 'Robin', ...bad }] });
    assert.equal(res.isError, true, JSON.stringify(bad));
  }
  const list = await r.call('list_labels', { species: 'robin' });
  assert.equal(list.structuredContent.total, 3);
  assert.deepEqual(list.structuredContent.labels[0], { id: 'n1', start: 3, end: 4, species: 'Robin', freqMin: 2000, freqMax: 4000 });
});

test('app tools: update maps species to label; unknown ids and no recording are errors', async () => {
  const app = fakeApp();
  const r = buildAppTools(app, { confirm: async () => true });
  await r.call('update_labels', { changes: [{ id: 'b', species: 'Dunnock', origin: 'manual' }] });
  // A new species drops the old scientific name (not in the taxonomy here → none).
  assert.deepEqual(app.calls.at(-1)[2], [{ id: 'b', patch: { origin: 'manual', label: 'Dunnock', scientificName: undefined } }]);
  await r.call('update_labels', { changes: [{ id: 'a', species: 'robin' }] });
  assert.equal(app.calls.at(-1)[2][0].patch.scientificName, 'Erithacus rubecula');
  await r.call('update_labels', { changes: [{ id: 'a', species: 'Tengmalm\'s Owl', tags: { type: 'song' } }] });
  assert.deepEqual(app.calls.at(-1)[2][0].patch, { tags: { type: 'song' } });
  assert.match((await r.call('update_labels', { changes: [{ id: 'zz' }] })).content[0].text, /Unknown label ids/);
  app.view = () => null;
  assert.match((await r.call('list_labels')).content[0].text, /No recording is open/);
});

test('app tools: delete asks; run_action refuses session-wiping actions; image comes as image content', async () => {
  const app = fakeApp();
  let asked = 0;
  const r = buildAppTools(app, { confirm: async () => { asked++; return true; } });
  assert.deepEqual((await r.call('delete_labels', { ids: ['a'] })).structuredContent, { deleted: 1 });
  assert.equal(asked, 1);
  assert.equal((await r.call('run_action', { id: 'space:review' })).content[0].text, 'ran: Go to Review');
  assert.equal((await r.call('run_action', { id: 'project:new-session' })).isError, true);
  assert.equal((await r.call('run_action', { id: 'nope' })).isError, true);
  assert.deepEqual(app.calls.filter((c) => c[0] === 'action'), [['action', 'space:review']]);
  const img = await r.call('get_spectrogram_image');
  assert.equal(img.content[0].type, 'image');
  assert.equal(img.content[1].text, 'Visible 0–60 s of 60 s.');
  app.view = () => ({ duration: 60, time: 0, start: 0, end: 60, freqMin: 0, freqMax: 10000 });
  assert.match((await r.call('get_spectrogram_image')).content[1].text, /0–10000 Hz/);
  await r.call('get_spectrogram_image', { labels: false, maxWidth: 600 });
  assert.deepEqual(app.calls.filter((c) => c[0] === 'png').map((c) => c.slice(1)), [[1200, true], [1200, true], [600, false]]);
  assert.deepEqual(await r.call('navigate', { start: 10, end: 20, time: 12 }).then((x) => x.isError), undefined);
  assert.deepEqual(app.calls.filter((c) => c[0] === 'zoom' || c[0] === 'seek'), [['zoom', 10, 20], ['seek', 12]]);
  assert.equal((await r.call('navigate', { start: 10 })).isError, true);
  assert.ok(r.list().every((t) => t.description.length > 20));
});

test('app tools: add rejects a label that is empty after clamping to the recording', async () => {
  const app = fakeApp();
  const r = buildAppTools(app, { confirm: async () => true });
  assert.equal((await r.call('add_labels', { labels: [{ start: 60, end: 61, species: 'Robin' }] })).isError, true);
  assert.equal(app.calls.filter((c) => c[0] === 'add').length, 0);
});

test('app tools: update checks the merged bounds and clamps the end', async () => {
  const app = fakeApp();
  const r = buildAppTools(app, { confirm: async () => true });
  for (const bad of [{ end: 0.5 }, { start: 3 }, { start: 70, end: 80 }, { freqMin: 1000 }, { freqMax: 400 }]) {
    const res = await r.call('update_labels', { changes: [{ id: 'a', ...bad }] });
    assert.equal(res.isError, true, JSON.stringify(bad));
  }
  assert.equal(app.calls.filter((c) => c[0] === 'upd').length, 0);
  await r.call('update_labels', { changes: [{ id: 'a', end: 99 }] });
  assert.deepEqual(app.calls.at(-1)[2], [{ id: 'a', patch: { end: 60 } }]);
});

test('app tools: label writes wait until the recording has loaded its labels', async () => {
  const app = fakeApp();
  app.labelsReady = () => false;
  const r = buildAppTools(app, { confirm: async () => true });
  assert.match((await r.call('add_labels', { labels: [{ start: 1, end: 2, species: 'Robin' }] })).content[0].text, /still loading/);
  assert.equal((await r.call('update_labels', { changes: [{ id: 'a', species: 'Robin' }] })).isError, true);
  assert.equal((await r.call('delete_labels', { ids: ['a'] })).isError, true);
  assert.equal((await r.call('run_birdnet')).isError, true);
  assert.equal(app.calls.filter((c) => ['add', 'upd', 'del'].includes(c[0])).length, 0);
  assert.equal((await r.call('list_labels')).isError, undefined);
});
