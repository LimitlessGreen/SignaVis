// Player features: installed once by name, torn down on destroy, boolean
// options resolved through the player class (empty in core, full in 'signavis').
import test from 'node:test';
import assert from 'node:assert/strict';
import { BirdNETPlayer as CorePlayer } from '../src/app/BirdNETPlayer.ts';
import { BirdNETPlayer as FullPlayer } from '../src/index.ts';

function bare(Cls, options = {}) {
    const p = Object.create(Cls.prototype);
    Object.assign(p, { options, _features: new Set(), _featureTeardowns: [] });
    return p;
}

test('use() installs a feature once and destroy-style teardown runs in reverse', () => {
    const p = bare(CorePlayer);
    const log = [];
    const f = (name) => ({ name, install: () => { log.push(`+${name}`); return () => log.push(`-${name}`); } });
    p.use(f('a')).use(f('b')).use(f('a'));
    assert.deepEqual(log, ['+a', '+b']);
    assert.ok(p.hasFeature('a') && p.hasFeature('b'));
    for (const t of p._featureTeardowns.splice(0).reverse()) t();
    assert.deepEqual(log, ['+a', '+b', '-b', '-a']);
});

test('options.features are installed; labelTable: true with core warns and installs nothing', () => {
    const seen = [];
    const p = bare(CorePlayer, { features: [{ name: 'x', install: () => seen.push('x') }], labelTable: true });
    const warn = console.warn; const warnings = [];
    console.warn = (m) => warnings.push(m);
    try { p._installFeatures(); } finally { console.warn = warn; }
    assert.deepEqual(seen, ['x']);
    assert.equal(p.hasFeature('labelTable'), false);
    assert.match(warnings[0], /signavis\/label-table/);
});

test('labelTable: true with the full player installs the table feature with labelTableColumns', () => {
    const p = bare(FullPlayer, { labelTable: true, labelTableColumns: ['label', 'start'] });
    let host = 0;
    p.enableLabelTable = () => { host++; return null; };   // no DOM: the feature stops after asking for its host
    p._installFeatures();
    assert.equal(p.hasFeature('labelTable'), true);
    assert.equal(host, 1);
});

test('an explicit labelTable feature wins over the option', () => {
    const p = bare(FullPlayer, { labelTable: true, features: [{ name: 'labelTable', install() {} }] });
    let host = 0;
    p.enableLabelTable = () => { host++; return null; };
    p._installFeatures();
    assert.equal(host, 0);
});
