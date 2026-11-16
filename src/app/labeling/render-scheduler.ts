// ═══════════════════════════════════════════════════════════════════════
// render-scheduler.ts — coalesces view updates
//
// Code that changes data calls invalidate('list', 'player', …) instead of redrawing
// views itself. All invalidations of one synchronous run are merged, and each step
// runs at most once per flush, in the order given to the constructor.
// Code that needs the views up to date right away (e.g. scrolling a new row into view)
// calls flush() first.
// ═══════════════════════════════════════════════════════════════════════

export type RenderStep<K extends string> = readonly [key: K, run: (pending: ReadonlySet<K>) => void];

export class RenderScheduler<K extends string> {
    private readonly _steps: ReadonlyArray<RenderStep<K>>;
    private readonly _schedule: (cb: () => void) => void;
    private _pending = new Set<K>();
    private _queued = false;

    constructor(steps: ReadonlyArray<RenderStep<K>>, schedule: (cb: () => void) => void = (cb) => queueMicrotask(cb)) {
        this._steps = steps;
        this._schedule = schedule;
    }

    /** Mark views as stale; they are redrawn in the next flush. */
    invalidate(...keys: K[]): void {
        for (const k of keys) this._pending.add(k);
        if (this._pending.size && !this._queued) {
            this._queued = true;
            this._schedule(() => this.flush());
        }
    }

    get pending(): ReadonlySet<K> { return this._pending; }

    /**
     * Run the stale steps now. Steps that invalidate again are picked up by the next flush.
     * A failing step is logged and does not stop the others.
     */
    flush(): void {
        this._queued = false;
        if (!this._pending.size) return;
        const batch = this._pending;
        this._pending = new Set();
        for (const [key, run] of this._steps) {
            if (!batch.has(key)) continue;
            try { run(batch); } catch (e) { console.error(`[render] step "${key}" failed`, e); }
        }
    }
}
