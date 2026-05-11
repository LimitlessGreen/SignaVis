// ═══════════════════════════════════════════════════════════════════════
// ToolbarController.ts — Manages compact toolbar, settings panel,
// transport-button enabled state, and follow/loop toggle button labels.
//
// Owns:
//   • compact toolbar layout (auto-detection + RAF scheduling)
//   • settings panel open/closed state
//   • transport button enabled/disabled bulk-toggling
//   • follow/loop toggle button text + aria labels
//
// All DOM refs and state accessors are injected via constructor.
// ═══════════════════════════════════════════════════════════════════════

export interface ToolbarDeps {
    container: {
        classList: {
            add: (...c: string[]) => void;
            remove: (...c: string[]) => void;
            toggle: (c: string, force?: boolean) => void;
            contains: (c: string) => boolean;
        };
    };
    d: {
        toolbarRoot:        { scrollWidth: number; clientWidth: number } | null;
        compactMoreBtn:     { disabled: boolean; setAttribute: (k: string, v: string) => void } | null;
        settingsToggleBtn:  { classList: { toggle: (c: string, force?: boolean) => void }; setAttribute: (k: string, v: string) => void } | null;
        settingsPanel:      { hidden: boolean } | null;
        playPauseBtn:       { disabled: boolean } | null;
        stopBtn:            { disabled: boolean } | null;
        jumpStartBtn:       { disabled: boolean } | null;
        jumpEndBtn:         { disabled: boolean } | null;
        backwardBtn:        { disabled: boolean } | null;
        forwardBtn:         { disabled: boolean } | null;
        followToggleBtn:    { disabled: boolean; classList: { toggle: (c: string, force?: boolean) => void }; textContent: string | null; title: string } | null;
        loopToggleBtn:      { disabled: boolean; classList: { toggle: (c: string, force?: boolean) => void }; textContent: string | null } | null;
        crosshairToggleBtn: { disabled: boolean } | null;
        fitViewBtn:         { disabled: boolean } | null;
        resetViewBtn:       { disabled: boolean } | null;
        autoContrastBtn:    { disabled: boolean } | null;
        autoFreqBtn:        { disabled: boolean } | null;
    };
    compactToolbarMode:  'auto' | 'on' | 'off';
    transportOverlay:    boolean;
    getFollowMode:       () => string;
    getLoopPlayback:     () => boolean;
    setFollowPlayback:   (v: boolean) => void;
}

export class ToolbarController {
    #container: ToolbarDeps['container'];
    #d: ToolbarDeps['d'];
    #compactToolbarMode: 'auto' | 'on' | 'off';
    #transportOverlay: boolean;
    #getFollowMode: () => string;
    #getLoopPlayback: () => boolean;
    #setFollowPlayback: (v: boolean) => void;

    #compactToolbarOpen = false;
    #settingsPanelOpen  = false;
    #layoutRaf          = 0;

    constructor(deps: ToolbarDeps) {
        this.#container = deps.container;
        this.#d = deps.d;
        this.#compactToolbarMode = deps.compactToolbarMode;
        this.#transportOverlay   = deps.transportOverlay;
        this.#getFollowMode      = deps.getFollowMode;
        this.#getLoopPlayback    = deps.getLoopPlayback;
        this.#setFollowPlayback  = deps.setFollowPlayback;
    }

    // ── Getters (used by PlayerState to read back the state) ─────────

    get compactToolbarOpen()  { return this.#compactToolbarOpen; }
    get settingsPanelOpen()   { return this.#settingsPanelOpen; }

    // ── Transport button enabling ─────────────────────────────────────

    setTransportEnabled(enabled: unknown): void {
        const en = !!enabled;
        [
            this.#d.playPauseBtn, this.#d.stopBtn,
            this.#d.jumpStartBtn, this.#d.jumpEndBtn,
            this.#d.backwardBtn,  this.#d.forwardBtn,
            this.#d.followToggleBtn, this.#d.loopToggleBtn,
            this.#d.crosshairToggleBtn,
            this.#d.fitViewBtn, this.#d.resetViewBtn,
            this.#d.autoContrastBtn, this.#d.autoFreqBtn,
        ].forEach((btn) => { if (btn) btn.disabled = !en; });
        this.queueLayoutRefresh();
    }

    // ── Follow / Loop toggle buttons ─────────────────────────────────

    updateToggleButtons(): void {
        const followMode = this.#getFollowMode();
        const followPlayback = followMode !== 'free';
        this.#setFollowPlayback(followPlayback);
        const fb = this.#d.followToggleBtn;
        if (fb) {
            fb.classList.toggle('active', followPlayback);
            fb.textContent = followMode === 'smooth'
                ? 'Smooth'
                : (followPlayback ? 'Follow' : 'Free');
            fb.title = followMode === 'smooth'
                ? 'Smooth follow (continuous)'
                : (followPlayback ? 'Follow playhead' : 'Free navigation');
        }
        const lb = this.#d.loopToggleBtn;
        if (lb) {
            const loop = this.#getLoopPlayback();
            lb.classList.toggle('active', loop);
            lb.textContent = loop ? 'Loop On' : 'Loop';
        }
        this.queueLayoutRefresh();
    }

    // ── Compact toolbar ───────────────────────────────────────────────

    isActive(): boolean {
        return this.#container.classList.contains('compact-toolbar-active');
    }

    setCompactToolbarOpen(nextOpen: unknown): void {
        const open = this.isActive() && !!nextOpen;
        this.#compactToolbarOpen = open;
        this.#container.classList.toggle('compact-toolbar-open', open);
        if (this.#d.compactMoreBtn) {
            this.#d.compactMoreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
    }

    queueLayoutRefresh(): void {
        if (this.#layoutRaf) return;
        this.#layoutRaf = requestAnimationFrame(() => {
            this.#layoutRaf = 0;
            this.refreshLayout();
        });
    }

    refreshLayout(): void {
        const active = this.#shouldBeActive();
        this.#container.classList.toggle('compact-toolbar-active', active);
        if (!active && this.#compactToolbarOpen) this.setCompactToolbarOpen(false);
        const btn = this.#d.compactMoreBtn;
        if (btn) {
            btn.disabled = !active;
            btn.setAttribute('aria-hidden', active ? 'false' : 'true');
        }
    }

    #shouldBeActive(): boolean {
        if (this.#transportOverlay) return false;
        if (this.#compactToolbarMode === 'off') return false;
        if (this.#compactToolbarMode === 'on') return true;
        const root = this.#d.toolbarRoot;
        if (!root) return false;
        const hadActive = this.#container.classList.contains('compact-toolbar-active');
        const hadOpen   = this.#container.classList.contains('compact-toolbar-open');
        if (hadActive) this.#container.classList.remove('compact-toolbar-active');
        if (hadOpen)   this.#container.classList.remove('compact-toolbar-open');
        const needsCompact = root.scrollWidth > root.clientWidth + 4;
        if (hadActive) this.#container.classList.add('compact-toolbar-active');
        if (hadOpen)   this.#container.classList.add('compact-toolbar-open');
        return needsCompact;
    }

    // ── Settings panel ────────────────────────────────────────────────

    setSettingsPanelOpen(open: unknown): void {
        this.#settingsPanelOpen = !!open;
        this.#container.classList.toggle('settings-panel-open', this.#settingsPanelOpen);
        const btn = this.#d.settingsToggleBtn;
        if (btn) {
            btn.classList.toggle('active', this.#settingsPanelOpen);
            btn.setAttribute('aria-expanded', this.#settingsPanelOpen ? 'true' : 'false');
        }
    }

    toggleSettingsPanel(): void {
        this.setSettingsPanelOpen(!this.#settingsPanelOpen);
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    dispose(): void {
        if (this.#layoutRaf) {
            cancelAnimationFrame(this.#layoutRaf);
            this.#layoutRaf = 0;
        }
    }
}
