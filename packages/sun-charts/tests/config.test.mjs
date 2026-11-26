import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, find, findAll, allText } from './fake-dom.mjs';

installFakeDom();
const { SunCharts, buildDayDial, buildDayChart, buildYearDial, resolveConfig, LABELS_DE } = await import('../src/index.ts');

const LEIPZIG = { lat: 51.34, lon: 12.37 };
const selected = (sel) => sel.children.find((o) => o.selected === true)?.value;
const mem = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), m }; };

test('resolveConfig: language code, partial labels, 12 h clock, colours', () => {
    assert.equal(resolveConfig({ labels: 'de' }).t.title, 'Licht');
    assert.equal(resolveConfig({ labels: 'de-AT' }).t.title, 'Licht');
    assert.equal(resolveConfig({ labels: 'xx' }).t.title, 'Light');
    assert.equal(resolveConfig({ labels: { title: 'Sun' } }).t.title, 'Sun');
    assert.equal(resolveConfig({ labels: { ...LABELS_DE, title: 'Sonne' } }).t.dawn, 'Morgens');
    const c12 = resolveConfig({ clock: '12h' });
    assert.equal(c12.time(0), '12:00 AM');
    assert.equal(c12.time(13 * 60 + 5), '1:05 PM');
    assert.equal(c12.timeShort(4 * 60 + 54), '4:54a');
    assert.equal(c12.hour(18), '6p');
    assert.equal(resolveConfig().time(4 * 60 + 54), '04:54');
    const col = resolveConfig({ colors: { phases: { civil: '#123456' } } });
    assert.equal(col.phaseFill('civil'), 'var(--sun-phase-civil, #123456)');
    assert.equal(col.phaseFill('day'), 'var(--sun-phase-day, #bfdcf5)');
    assert.equal(col.seasonFill('summer'), 'var(--sun-season-summer, #e6bb4a)');
});

test('German labels reach the dials', () => {
    const day = buildDayDial(LEIPZIG, '2026-11-20', null, 1, 0, { labels: 'de', moon: true });
    const txt = allText(day);
    assert.match(txt, /keine Zeit/);
    assert.match(txt, /Mond: .*beleuchtet/);
    const year = allText(buildYearDial(LEIPZIG, '2026-11-20', { labels: 'de' }));
    assert.match(year, /Spätherbst/);
    assert.match(year, /WINTER/);
    assert.match(year, /noch|T →/);
});

test('12 h clock on the dial hour marks and event labels', () => {
    const txt = allText(buildDayDial(LEIPZIG, '2026-11-20', '07:30', 1, 0, { clock: '12h' }));
    assert.match(txt, /\b6a\b/);
    assert.match(txt, /7:30 AM/);
    assert.doesNotMatch(txt, /\b07:30\b/);
});

test('phase colours use CSS variables with the configured fallback', () => {
    const dial = buildDayDial(LEIPZIG, '2026-11-20', null, 1, 0, { colors: { phases: { night: 'black' } } });
    const fills = findAll(dial, (n) => n.attrs?.style?.startsWith('fill: var(--sun-phase-'));
    assert.ok(fills.length >= 5);
    assert.ok(fills.some((n) => n.attrs.style === 'fill: var(--sun-phase-night, black)'));
});

test('events: false drops the dawn/dusk table and ring labels', () => {
    const withEv = buildDayChart(LEIPZIG, '2026-11-20', '07:30', 1);
    const without = buildDayChart(LEIPZIG, '2026-11-20', '07:30', 1, 0, { events: false });
    assert.ok(find(withEv, (n) => n.className === 'sun-chart-events'));
    assert.equal(find(without, (n) => n.className === 'sun-chart-events'), null);
    const dial = buildDayDial(LEIPZIG, '2026-11-20', '07:30', 1, 0, { events: false });
    assert.equal(findAll(dial, (n) => n.attrs?.class?.startsWith('sun-ev')).length, 0);
});

test('parts can be hidden; fixed view without switch', () => {
    const storage = mem();
    storage.set('aw.props.lightView', 'chart');
    const sc = new SunCharts({ storage, view: 'dial', show: { viewSwitch: false, zone: false, year: false, title: false } });
    sc.render(LEIPZIG, '2026-11-20', '07:30');
    assert.equal(find(sc.el, (n) => n.className === 'sun-view-switch'), null);
    assert.equal(find(sc.el, (n) => n.className === 'sun-charts-zone'), null);
    assert.equal(find(sc.el, (n) => n.className === 'sun-charts-head'), null, 'empty header left out');
    const body = find(sc.el, (n) => n.className === 'sun-dials');
    assert.ok(body, 'fixed dial view wins over the stored choice');
    assert.equal(body.children.length, 1, 'only the day dial');
});

test('view option is the default when nothing is stored; onViewChange fires', () => {
    const seen = [];
    const sc = new SunCharts({ storage: mem(), view: 'dial', onViewChange: (v) => seen.push(v) });
    sc.render(LEIPZIG, '2026-11-20', '07:30');
    assert.ok(find(sc.el, (n) => n.className === 'sun-dials'));
    const chartBtn = find(sc.el, (n) => n.tagName === 'button' && n.textContent === 'Chart');
    chartBtn.listeners.click[0]();
    assert.deepEqual(seen, ['chart']);
    assert.ok(find(sc.el, (n) => n.className === 'sun-lines'));
});

test('zone: utcOffset argument, onZoneChange with null for the automatic zone', () => {
    const changes = [];
    const sc = new SunCharts({ storage: mem(), onZoneChange: (c) => changes.push(c) });
    sc.render(LEIPZIG, '2026-11-20', '07:30', 0, 0); // saved earlier as UTC
    const sel = find(sc.el, (n) => n.className === 'sun-charts-zone');
    assert.equal(selected(sel), '0');
    sel.value = '1';
    sel.listeners.change[0]();
    assert.equal(changes[0].utcOffset, null, 'back to local time');
    assert.equal(changes[0].effective, 1);
    const sel2 = find(sc.el, (n) => n.className === 'sun-charts-zone');
    sel2.value = '-3';
    sel2.listeners.change[0]();
    assert.equal(changes[1].utcOffset, -3);
    assert.equal(selected(find(sc.el, (n) => n.className === 'sun-charts-zone')), '-3');
});

test('update() switches language and redraws', () => {
    const sc = new SunCharts({ storage: mem() });
    sc.render(LEIPZIG, '2026-11-20', '07:30');
    assert.equal(find(sc.el, (n) => n.className === 'sun-charts-title').textContent, 'Light');
    sc.update({ labels: 'de' });
    assert.equal(find(sc.el, (n) => n.className === 'sun-charts-title').textContent, 'Licht');
});

test('moon disc moves aside when it would cover the sun', () => {
    // Leipzig, 20 Nov 2026 06:40: sun and moon sit close together on the dial
    const dial = buildDayDial(LEIPZIG, '2026-11-20', '06:40', 1, 0, { moon: true });
    const sun = find(dial, (n) => n.attrs?.class?.startsWith('sun-disc'));
    const moon = find(dial, (n) => /^sun-moon( |$)/.test(n.attrs?.class ?? ''));
    assert.ok(find(dial, (n) => n.attrs?.class === 'sun-moon-leader'), 'leader to the true place');
    const disc = moon.children[0];
    const d = Math.hypot(disc.attrs.cx - sun.attrs.cx, disc.attrs.cy - sun.attrs.cy);
    assert.ok(d >= 12, `discs apart: ${d}`);
    // No leader when they are far apart (22:00: moon high, sun deep below)
    const noon = buildDayDial(LEIPZIG, '2026-11-20', '22:00', 1, 0, { moon: true });
    assert.equal(find(noon, (n) => n.attrs?.class === 'sun-moon-leader'), null);
});
