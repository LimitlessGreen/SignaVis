import test from 'node:test';
import assert from 'node:assert/strict';

import { moonEvents, moonIllumination, moonAltitude, phaseName } from '../src/moon.ts';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// Reference values: PyEphem 4.2.1 (pressure 0), local clock minutes; see packages/sun-charts/README.md.
const CASES = [
    // name, lat, lon, date, utc offset, rise, set, illumination at noon, altitude at 22:00, phase name, rise/set tolerance
    ['Berlin', 52.52, 13.405, '2024-06-21', 2, 1322.2, 195.0, 0.994, -0.46, 'full moon', 10],
    ['Leipzig', 51.34, 12.37, '2026-11-20', 1, 843.8, 122.9, 0.785, 41.24, 'waxing gibbous', 10],
    ['Sydney', -33.87, 151.21, '2025-03-10', 11, 1043.2, 141.5, 0.83, 32.47, 'waxing gibbous', 10],
    ['Tromsø', 69.65, 18.96, '2025-01-15', 1, 894.6, 718.9, 0.973, 28.33, 'waning gibbous', 20],
];

for (const [name, lat, lon, date, off, rise, set, illum, alt22, phase, tol] of CASES) {
    test(`moon over ${name} on ${date}`, () => {
        const ev = moonEvents(lat, lon, date, off);
        near(ev.find((e) => e.kind === 'rise').minutes, rise, tol, 'moonrise');
        near(ev.find((e) => e.kind === 'set').minutes, set, tol, 'moonset');
        const i = moonIllumination(date, 720, off);
        near(i.fraction, illum, 0.02, 'illuminated fraction');
        assert.equal(i.name, phase);
        near(moonAltitude(lat, lon, date, 22 * 60, off), alt22, 1.5, 'altitude at 22:00');
    });
}

test('phase names', () => {
    assert.equal(phaseName(0), 'new moon');
    assert.equal(phaseName(0.99), 'new moon');
    assert.equal(phaseName(0.12), 'waxing crescent');
    assert.equal(phaseName(0.25), 'first quarter');
    assert.equal(phaseName(0.62), 'waning gibbous');
    assert.equal(phaseName(0.8), 'waning crescent');
});
