import test from 'node:test';
import assert from 'node:assert/strict';

import { moonEvents, moonIllumination, moonAltitude, phaseName } from '../src/moon.ts';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// Reference values: PyEphem 4.2.1 (default refraction, upper limb on the horizon), local clock minutes.
const CASES = [
    // name, lat, lon, date, utc offset, rise, set, illumination at noon, altitude at 22:00, phase name, rise/set tolerance
    ['Berlin', 52.52, 13.405, '2024-06-21', 2, 1315.3, 201.5, 0.994, 0.08, 'full moon', 10],
    ['Leipzig', 51.34, 12.37, '2026-11-20', 1, 839.8, 127.1, 0.785, 41.26, 'waxing gibbous', 10],
    ['Sydney', -33.87, 151.21, '2025-03-10', 11, 1039.7, 145.2, 0.83, 32.5, 'waxing gibbous', 10],
    ['Tromsø', 69.65, 18.96, '2025-01-15', 1, 869.5, 743.9, 0.973, 28.35, 'waning gibbous', 15],
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
