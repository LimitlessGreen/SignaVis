import test from 'node:test';
import assert from 'node:assert/strict';
import { overlapClusterLayout } from '../src/domain/annotations.ts';

// The former union-find from AnnotationLayer.render(), kept as the reference.
function unionFindLayout(sorted, rowMap) {
    const localLayout = new Map();
    const par = new Map();
    const find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x) || x) || x); x = String(par.get(x)); } return x; };
    for (const r of sorted) par.set(r.id, r.id);
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            if (sorted[j].start >= sorted[i].end) break;
            const ra = find(sorted[i].id), rb = find(sorted[j].id);
            if (ra !== rb) par.set(ra, rb);
        }
    }
    const clusters = new Map();
    for (const r of sorted) { const root = find(r.id); if (!clusters.has(root)) clusters.set(root, []); clusters.get(root).push({ id: r.id, row: rowMap.get(r.id) ?? 0 }); }
    for (const [, members] of clusters) {
        if (members.length < 2) continue;
        const rowsSorted = [...new Set(members.map((m) => m.row))].sort((a, b) => a - b);
        if (rowsSorted.length < 2) continue;
        for (const m of members) localLayout.set(m.id, { depth: rowsSorted.length, localRow: rowsSorted.indexOf(m.row) });
    }
    return localLayout;
}

// Swimlane rows as AnnotationLayer.render() assigns them.
function rows(sorted) {
    const rowEnds = []; const rowMap = new Map();
    for (const r of sorted) {
        let row = rowEnds.findIndex((e) => r.start >= e);
        if (row < 0) { row = rowEnds.length; rowEnds.push(r.end); } else rowEnds[row] = r.end;
        rowMap.set(r.id, row);
    }
    return rowMap;
}

test('overlapClusterLayout matches the pairwise union-find on random regions', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 300; trial++) {
        const n = 1 + Math.floor(rnd() * 40);
        const items = Array.from({ length: n }, (_, i) => { const s = Math.round(rnd() * 200) / 10; return { id: 'r' + i, start: s, end: s + Math.round(rnd() * 30 + 1) / 10 }; });
        const sorted = items.sort((a, b) => a.start - b.start || a.end - b.end);
        const rowMap = rows(sorted);
        assert.deepEqual([...overlapClusterLayout(sorted, rowMap)].sort(), [...unionFindLayout(sorted, rowMap)].sort(), `trial ${trial}`);
    }
});

test('overlapClusterLayout: touching regions are separate clusters, a bridge joins two', () => {
    const sorted = [{ id: 'a', start: 0, end: 2 }, { id: 'b', start: 1, end: 3 }, { id: 'c', start: 3, end: 4 }];
    const layout = overlapClusterLayout(sorted, rows(sorted));
    assert.deepEqual(layout.get('a'), { depth: 2, localRow: 0 });
    assert.deepEqual(layout.get('b'), { depth: 2, localRow: 1 });
    assert.equal(layout.has('c'), false);
});
