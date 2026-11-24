import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LABEL_PALETTE, assignLabelColors, colorDistance, labelColorForName, planLabelColors, resetLabelColors, timeConflicts,
} from '../src/domain/labelColors.ts';
import { colorForName } from '../src/domain/annotations.ts';

const SPECIES = ['American Goldfinch', 'Black-capped Chickadee', 'Blue Jay', 'Dark-eyed Junco', 'House Finch', 'Northern Cardinal'];

test('labelColors: names up to the palette size all get different colours', () => {
    const plan = planLabelColors(LABEL_PALETTE.map((_, i) => `species ${i}`));
    assert.equal(new Set(plan.values()).size, LABEL_PALETTE.length);
});

test('labelColors: adjacent overview rows are clearly different', () => {
    const plan = planLabelColors(SPECIES);
    const colors = SPECIES.map((s) => plan.get(s.toLowerCase()));
    for (let i = 1; i < colors.length; i++) {
        assert.ok(colorDistance(colors[i], colors[i - 1]) >= 20, `${SPECIES[i - 1]} / ${SPECIES[i]}`);
    }
});

test('labelColors: past the palette size, rows and simultaneous labels still differ', () => {
    const names = Array.from({ length: 25 }, (_, i) => `sp${String(i).padStart(2, '0')}`);
    const conflicts = timeConflicts(names.map((name, i) => ({ name, start: (i % 5) * 3, end: (i % 5) * 3 + 3 })));
    const plan = planLabelColors(names, conflicts);
    for (let i = 1; i < names.length; i++) {
        assert.notEqual(plan.get(names[i]), plan.get(names[i - 1]));
        assert.notEqual(plan.get(names[i]), plan.get(names[i - 2] ?? ''));
    }
});

test('labelColors: timeConflicts links names whose labels overlap', () => {
    const c = timeConflicts([
        { name: 'A', start: 0, end: 3 }, { name: 'B', start: 2, end: 5 }, { name: 'C', start: 5, end: 8 },
    ]);
    assert.deepEqual([...c.get('a')], ['b']);
    assert.deepEqual([...c.get('b')], ['a']);
    assert.equal(c.has('c'), false);
});

test('labelColors: assignLabelColors plans colourless labels in overview order and keeps given colours', () => {
    resetLabelColors();
    const labels = [...SPECIES].reverse().map((label, i) => ({ label, origin: 'BirdNET', start: i * 3, end: i * 3 + 3 }));
    labels.push({ label: 'Painted', origin: 'BirdNET', color: '#123456', start: 0, end: 1 });
    const plan = assignLabelColors(labels);
    assert.equal(plan.has('painted'), false);
    assert.deepEqual([...plan.entries()], [...planLabelColors(SPECIES, timeConflicts(labels.filter((l) => !l.color).map((l) => ({ ...l, name: l.label })))).entries()]);
    assert.equal(labelColorForName('Blue Jay'), plan.get('blue jay'));
    assert.equal(colorForName('blue jay '), plan.get('blue jay'));
});

test('labelColors: names coloured one at a time get different colours', () => {
    resetLabelColors();
    const colors = SPECIES.map((s) => colorForName(s));
    assert.equal(new Set(colors).size, SPECIES.length);
    assert.equal(colorForName(SPECIES[0]), colors[0]);
});
