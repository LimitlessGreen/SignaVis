// ═══════════════════════════════════════════════════════════════════════
// app/lite/assistant-undo.ts — one Undo for AI changes that follow each other
//
// The app's undo is the "… · Undo" toast, and only one toast shows at a time: a second AI change
// would replace the first one's toast and its undo would be lost (fast in "don't ask" mode).
// While the previous AI toast is still showing, the next change joins it: one toast, and Undo
// runs every step's undo, newest first, back to the state before the first change.
// Anything the person does in between (click, key) ends the chain (`reset`), so an Undo never
// reaches back over their own edits.
// ═══════════════════════════════════════════════════════════════════════

export const AI_UNDO_WINDOW_MS = 8000;   // = the toast's timeout

export class AssistantUndoChain {
    private steps: (() => void)[] = [];
    private summaries: string[] = [];
    private at = -Infinity;

    private readonly now: () => number;
    private readonly windowMs: number;

    constructor(now: () => number = Date.now, windowMs = AI_UNDO_WINDOW_MS) {
        this.now = now;
        this.windowMs = windowMs;
    }

    /** The person acted: the next AI change starts its own Undo. */
    reset(): void { this.steps = []; this.summaries = []; this.at = -Infinity; }

    /** Add a step; returns the toast text and the undo for the whole chain. */
    add(summary: string, undo: () => void): { summary: string; undo: () => void } {
        const t = this.now();
        if (t - this.at >= this.windowMs) { this.steps = []; this.summaries = []; }
        this.at = t;
        this.steps.push(undo);
        this.summaries.push(summary);
        const steps = this.steps;
        const text = steps.length === 1 ? summary : `AI: ${steps.length} changes (last: ${summary.replace(/^AI: /, '')})`;
        return {
            summary: text,
            undo: () => {
                // Only this chain, once; a later chain starts empty.
                if (this.steps === steps) { this.steps = []; this.summaries = []; this.at = -Infinity; }
                for (const u of [...steps].reverse()) u();
                steps.length = 0;
            },
        };
    }
}
