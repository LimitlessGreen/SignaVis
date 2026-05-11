// ═══════════════════════════════════════════════════════════════════════
// PerfOverlay.ts — Developer performance overlay for the player
//
// Owns:
//   • All perf metric state (fps, frame times, event counts, etc.)
//   • DOM panel creation and periodic rendering
//   • Clean-up on dispose()
//
// Metric properties are intentionally public so PlayerState methods
// can increment them inline (e.g. `this._perf.uiFlushes += 1`).
// ═══════════════════════════════════════════════════════════════════════

export class PerfOverlay {
    enabled = false;
    panel: HTMLDivElement | null = null;

    // ── Metrics (public: PlayerState increments these inline) ─────────
    frames = 0;
    fps = 0;
    lastFrameTs = 0;
    longFrames = 0;
    maxFrameMs = 0;
    uiFlushes = 0;
    timeupdateEvents = 0;
    selectionEvents = 0;
    seekEvents = 0;
    transitionEvents = 0;
    blockedTransitions = 0;
    lastTransition = '';

    #intervalId: ReturnType<typeof setInterval> | null = null;
    #getTransportState: () => string;

    constructor({ container, options, getTransportState }: {
        container: HTMLElement;
        options: any;
        getTransportState: () => string;
    }) {
        this.#getTransportState = getTransportState;

        const byOption = options?.enablePerfOverlay === true;
        let byQuery = false;
        try {
            const params = new URLSearchParams(window.location.search || '');
            byQuery = params.get('perf') === '1';
        } catch {
            byQuery = false;
        }
        if (!byOption && !byQuery) return;

        this.enabled = true;

        const panel = document.createElement('div') as HTMLDivElement;
        panel.className = 'abp-perf-overlay';
        // Hard-pin overlay position so special layout modes cannot shift it.
        panel.style.position = 'absolute';
        panel.style.top = '8px';
        panel.style.right = '8px';
        panel.style.left = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
        panel.style.zIndex = '60';
        panel.innerHTML = `
            <div class="abp-perf-title">PERF</div>
            <div class="abp-perf-body">Initializing...</div>
        `;
        container.appendChild(panel);
        this.panel = panel;

        this.#intervalId = setInterval(() => this.render(), 500);
    }

    onFrame(ts: number) {
        if (!this.enabled) return;
        this.frames += 1;
        if (this.lastFrameTs > 0) {
            const frameMs = ts - this.lastFrameTs;
            if (frameMs > 0) {
                const fps = 1000 / frameMs;
                this.fps = this.fps <= 0 ? fps : (this.fps * 0.85 + fps * 0.15);
            }
            this.maxFrameMs = Math.max(this.maxFrameMs, frameMs);
            if (frameMs > 32) this.longFrames += 1;
        }
        this.lastFrameTs = ts;
    }

    render() {
        if (!this.enabled || !this.panel) return;
        const body = this.panel.querySelector('.abp-perf-body');
        if (!body) return;
        body.innerHTML = [
            `state: ${this.#getTransportState() || 'n/a'}`,
            `fps: ${this.fps.toFixed(1)} | long>${32}ms: ${this.longFrames}`,
            `max frame: ${this.maxFrameMs.toFixed(1)}ms | ui flushes: ${this.uiFlushes}`,
            `timeupdate: ${this.timeupdateEvents} | selection: ${this.selectionEvents} | seek: ${this.seekEvents}`,
            `transitions: ${this.transitionEvents} | blocked: ${this.blockedTransitions}`,
            `last: ${this.lastTransition || '-'}`,
        ].join('<br>');

        // Show rates over each reporting window.
        this.uiFlushes = 0;
        this.timeupdateEvents = 0;
        this.selectionEvents = 0;
        this.seekEvents = 0;
        this.maxFrameMs = 0;
    }

    dispose() {
        if (this.#intervalId !== null) {
            clearInterval(this.#intervalId);
            this.#intervalId = null;
        }
        if (this.panel?.parentNode) {
            this.panel.parentNode.removeChild(this.panel);
            this.panel = null;
        }
    }
}
