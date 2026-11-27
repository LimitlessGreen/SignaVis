// ═══════════════════════════════════════════════════════════════════════
// app/lite/assistant-undo.ts — one Undo for AI changes that follow each other
//
// The app's undo is the "… · Undo" toast, and only one toast shows at a time: a second AI change
// would replace the first one's toast and its undo would be lost (fast in "don't ask" mode).
// While the previous AI toast is still showing, the next change joins it: one toast, and Undo
// reverts to the state before the first change of the chain.
// Anything the person does in between (click, key) ends the chain (`reset`), so an Undo never
// reaches back over their own edits.
// Memory: a `full` step restores the whole label state, so once the chain has one, later steps
// are not kept (that first snapshot already covers them). Steps before it run after it, newest
// first. The chain is let go when its toast has gone.
// ═══════════════════════════════════════════════════════════════════════

export const AI_UNDO_WINDOW_MS = 8000;   // = the toast's timeout

export class AssistantUndoChain {
    private steps: (() => void)[] = [];
    private full: (() => void) | null = null;
    private count = 0;
    private at = -Infinity;
    private timer: unknown = null;
    private readonly now: () => number;
    private readonly windowMs: number;
    private readonly schedule: (fn: () => void, ms: number) => unknown;
    private readonly cancel: (t: unknown) => void;

    constructor(now: () => number = Date.now, windowMs = AI_UNDO_WINDOW_MS,
        schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
        cancel: (t: unknown) => void = (t) => clearTimeout(t as ReturnType<typeof setTimeout>)) {
        this.now = now;
        this.windowMs = windowMs;
        this.schedule = schedule;
        this.cancel = cancel;
    }

    /** Number of undo closures held (tests: memory stays bounded). */
    get held(): number { return this.steps.length + (this.full ? 1 : 0); }

    /** The person acted (or the toast has gone): the next AI change starts its own Undo. */
    reset(): void {
        this.steps = [];
        this.full = null;
        this.count = 0;
        this.at = -Infinity;
        if (this.timer != null) { this.cancel(this.timer); this.timer = null; }
    }

    /** Add a step; `full` = its undo restores the whole label state. Returns the toast text and the chain's undo. */
    add(summary: string, undo: () => void, { full = false }: { full?: boolean } = {}): { summary: string; undo: () => void } {
        const t = this.now();
        if (t - this.at >= this.windowMs) this.reset();
        this.at = t;
        this.count++;
        if (!this.full) {
            if (full) this.full = undo;
            else this.steps.push(undo);
        }
        if (this.timer != null) this.cancel(this.timer);
        this.timer = this.schedule(() => { this.timer = null; this.reset(); }, this.windowMs);
        const run = [...(this.full ? [this.full] : []), ...[...this.steps].reverse()];
        let done = false;
        return {
            summary: this.count === 1 ? summary : `AI: ${this.count} changes (last: ${summary.replace(/^AI: /, '')})`,
            undo: () => {
                if (done) return;
                done = true;
                this.reset();
                for (const u of run) u();
            },
        };
    }
}
