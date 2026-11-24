// Label colours: a fixed palette of clearly different colours, handed out so
// that labels seen next to each other (adjacent rows of the label overview,
// labels at the same time) differ as much as the palette allows.

/** Vivid enough for the dark spectrogram, distinct as 35 % tints on light rows. */
export const LABEL_PALETTE: readonly string[] = [
    '#3d8ef0', // blue
    '#f28a2e', // orange
    '#2fbf71', // green
    '#e45ba8', // magenta
    '#e8c42a', // yellow
    '#8b6cf0', // violet
    '#2cc5c9', // cyan
    '#e5534b', // red
    '#a8e05a', // lime
    '#b0b8c8', // grey-blue
];

const toLinear = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function oklab(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    const r = toLinear(n >> 16), g = toLinear((n >> 8) & 255), b = toLinear(n & 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

const LAB = new Map(LABEL_PALETTE.map((c) => [c, oklab(c)]));

/** Perceptual distance (OKLab ×100) between two palette colours. */
export function colorDistance(a: string, b: string): number {
    const x = LAB.get(a) ?? oklab(a), y = LAB.get(b) ?? oklab(b);
    return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const key = (name: string) => name.trim().toLowerCase();

/**
 * The palette colour for `name` that is farthest from the colours of its
 * `neighbors`, preferring colours used least so far (`uses`), then the one
 * farthest from all colours in use.
 */
function pickColor(neighbors: string[], uses: Map<string, number>): string {
    const inUse = [...uses.keys()].filter((c) => uses.get(c)! > 0);
    let best = LABEL_PALETTE[0], bestScore = -Infinity;
    for (const c of LABEL_PALETTE) {
        const near = neighbors.length ? Math.min(...neighbors.map((n) => colorDistance(c, n))) : 100;
        const spread = inUse.length ? Math.min(...inUse.map((n) => colorDistance(c, n))) : 100;
        // A reused colour is worth it only when it keeps neighbours far apart.
        const score = Math.min(near, 40) - 25 * (uses.get(c) ?? 0) + 0.1 * spread;
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
}

/**
 * Colours for `names` in display order (rows of the label overview). Each name
 * avoids the colours of the two rows above it and of the names in `conflicts`
 * (labels at the same time). Keys are lower-cased names.
 */
export function planLabelColors(names: string[], conflicts: Map<string, Set<string>> = new Map()): Map<string, string> {
    const plan = new Map<string, string>();
    const uses = new Map<string, number>();
    const order: string[] = [];
    for (const raw of names) {
        const k = key(raw);
        if (!k || plan.has(k)) continue;
        const neighbors = [order[order.length - 1], order[order.length - 2], ...(conflicts.get(k) ?? [])]
            .map((n) => (n ? plan.get(n) : undefined))
            .filter((c): c is string => !!c);
        const color = pickColor(neighbors, uses);
        plan.set(k, color);
        uses.set(color, (uses.get(color) ?? 0) + 1);
        order.push(k);
    }
    return plan;
}

/** Names whose labels overlap in time (lower-cased, both directions). */
export function timeConflicts(labels: { name: string; start: number; end: number }[]): Map<string, Set<string>> {
    const conflicts = new Map<string, Set<string>>();
    const sorted = labels
        .map((l) => ({ k: key(l.name), start: l.start, end: l.end }))
        .filter((l) => l.k)
        .sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
            const a = sorted[i].k, b = sorted[j].k;
            if (a === b) continue;
            if (!conflicts.has(a)) conflicts.set(a, new Set());
            if (!conflicts.has(b)) conflicts.set(b, new Set());
            conflicts.get(a)!.add(b);
            conflicts.get(b)!.add(a);
        }
    }
    return conflicts;
}

// Colours given out so far: a name keeps its colour for the page's lifetime.
const assigned = new Map<string, string>();

/** Records planned colours, so later labels of these names get the same ones. */
export function rememberLabelColors(plan: Map<string, string>): void {
    for (const [k, c] of plan) assigned.set(k, c);
}

/** The colour of a name: the one it was given, else a new one far from those in use. */
export function labelColorForName(name: string): string {
    const k = key(name);
    let color = assigned.get(k);
    if (!color) {
        const uses = new Map<string, number>();
        for (const c of assigned.values()) uses.set(c, (uses.get(c) ?? 0) + 1);
        color = pickColor([...assigned.values()].slice(-2), uses);
        assigned.set(k, color);
    }
    return color;
}

/** Test hook: forget all given colours. */
export function resetLabelColors(): void {
    assigned.clear();
}

const ORIGIN_ORDER: Record<string, number> = { manual: 0, BirdNET: 1, 'xeno-canto': 2 };

/**
 * Colours for the labels without one, planned in the order of the label
 * overview (origin groups, names alphabetical) and remembered.
 */
export function assignLabelColors(labels: { label?: string; species?: string; origin?: string; color?: string; start?: number; end?: number }[]): Map<string, string> {
    const rows = new Map<string, Set<string>>();
    const timed: { name: string; start: number; end: number }[] = [];
    for (const l of labels) {
        const name = String(l.label ?? l.species ?? '').trim();
        if (!name || l.color) continue;
        const origin = String(l.origin || 'manual').trim() || 'manual';
        if (!rows.has(origin)) rows.set(origin, new Set());
        rows.get(origin)!.add(name);
        timed.push({ name, start: Number(l.start) || 0, end: Number(l.end) || 0 });
    }
    const order = [...rows.entries()]
        .sort((a, b) => (ORIGIN_ORDER[a[0]] ?? 99) - (ORIGIN_ORDER[b[0]] ?? 99) || a[0].localeCompare(b[0]))
        .flatMap(([, names]) => [...names].sort((a, b) => a.localeCompare(b)));
    const plan = planLabelColors(order, timeConflicts(timed));
    rememberLabelColors(plan);
    return plan;
}
