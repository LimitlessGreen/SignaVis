// ═══════════════════════════════════════════════════════════════════════
// app/lite/spaces.ts — Spaces in SignaVis Lite (tabs at the top, panels below)
//
// Each space has its own dock layout (dockview-core). A panel is one DOM
// element that lives in exactly one space: the editor (player + both
// sidebars) in Annotate, the library in Browse, the embedding map in
// Embeddings. Switching spaces only hides the others, so Browse keeps its
// filter and scroll position while a recording is open in Annotate.
// Layout and active space are stored per project (spaces-state.ts).
// Web and phone keep the plain layout; this is only built in Lite.
// ═══════════════════════════════════════════════════════════════════════

import type { DockviewApi, IContentRenderer } from 'dockview-core';
import '../../styles/vendor/dockview.css';
import {
    isVisible, layoutUsable, parseSpacesState, stringifySpacesState,
    type SpaceDef, type SpacesState,
} from './spaces-state.ts';

export interface PanelDef {
    id: string;
    title: string;
    /** Called once, the first time the panel is placed; fills `host`. */
    mount: (host: HTMLElement) => void;
    /** The panel became visible (its space is shown and its tab is active). */
    onShow?: () => void;
}

export interface SpacesStorage {
    load: () => Promise<string | null>;
    save: (text: string) => Promise<void>;
}

export interface SpacesShellOptions {
    /** The space tabs are inserted before this element (in the top bar). */
    tabsBefore: Element;
    /** Element whose place the spaces take (it is moved into its panel by that panel's mount). */
    replace: HTMLElement;
    spaces: SpaceDef[];
    panels: PanelDef[];
    storage: SpacesStorage;
    defaultActive: string;
    /** Spaces built right away, even when another one is shown (Annotate: the editor must be in the page). */
    eager?: string[];
    /** After a space was shown (e.g. resize the player). */
    onSpaceShown?: (id: string) => void;
}

interface SpaceRuntime {
    def: SpaceDef;
    el: HTMLElement;
    tab: HTMLButtonElement;
    api: DockviewApi | null;
}

const SAVE_DELAY_MS = 600;

export class SpacesShell {
    readonly el: HTMLElement;
    #o: SpacesShellOptions;
    #state: SpacesState;
    #spaces = new Map<string, SpaceRuntime>();
    #panels = new Map<string, { def: PanelDef; host: HTMLElement; mounted: boolean }>();
    #tabs: HTMLElement;
    #dv: typeof import('dockview-core') | null = null;
    #saveTimer: ReturnType<typeof setTimeout> | null = null;

    private constructor(o: SpacesShellOptions, state: SpacesState) {
        this.#o = o;
        this.#state = state;
        this.el = document.createElement('div');
        this.el.className = 'spaces-host';
        this.#tabs = document.createElement('nav');
        this.#tabs.className = 'spaces-tabs';
        this.#tabs.setAttribute('role', 'tablist');
        this.#tabs.setAttribute('aria-label', 'Spaces');
        o.tabsBefore.before(this.#tabs);
        this.#tabs.addEventListener('keydown', (e) => this.#onTabKey(e));
        for (const p of o.panels) {
            const host = document.createElement('div');
            host.className = 'space-panel';
            host.dataset.panel = p.id;
            this.#panels.set(p.id, { def: p, host, mounted: false });
        }
        for (const def of o.spaces) {
            const el = document.createElement('section');
            el.className = 'space';
            el.dataset.space = def.id;
            el.id = `space-${def.id}`;
            el.setAttribute('role', 'tabpanel');
            el.setAttribute('aria-labelledby', `space-tab-${def.id}`);
            el.hidden = true;
            this.el.appendChild(el);
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'spaces-tab';
            tab.id = `space-tab-${def.id}`;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-controls', el.id);
            tab.dataset.space = def.id;
            tab.innerHTML = `${def.icon}<span></span>`;
            tab.querySelector('span')!.textContent = def.title;
            tab.addEventListener('click', () => void this.show(def.id));
            this.#tabs.appendChild(tab);
            this.#spaces.set(def.id, { def, el, tab, api: null });
        }
        o.replace.replaceWith(this.el);
        this.#syncTabs();
    }

    /** Build the shell in place of `o.replace` and show the stored (or default) space. */
    static async create(o: SpacesShellOptions): Promise<SpacesShell> {
        let text: string | null = null;
        try { text = await o.storage.load(); } catch (e) { console.warn('[spaces] cannot read the layout', e); }
        const shell = new SpacesShell(o, parseSpacesState(text, o.spaces, o.defaultActive));
        shell.#dv = await import('dockview-core');
        for (const id of o.eager ?? []) {
            const sp = shell.#spaces.get(id);
            if (sp && !sp.api) shell.#build(sp);
        }
        const first = shell.#spaces.get(shell.#state.active);
        await shell.show(first && isVisible(first.def, shell.#state) ? shell.#state.active : o.defaultActive);
        return shell;
    }

    get active(): string { return this.#state.active; }

    /** Make an optional space (Embeddings) available; it then stays. */
    setAvailable(id: string) {
        const s = this.#state.spaces[id] ?? (this.#state.spaces[id] = { layout: null });
        if (s.available) return;
        s.available = true;
        this.#syncTabs();
        this.#scheduleSave();
    }

    /** Show a space; builds its layout the first time. */
    async show(id: string) {
        const sp = this.#spaces.get(id);
        if (!sp) return;
        if (sp.def.optional) this.setAvailable(id);
        for (const other of this.#spaces.values()) other.el.hidden = other !== sp;
        if (this.#state.active !== id) {
            this.#state.active = id;
            this.#scheduleSave();
        }
        this.#syncTabs();
        if (!sp.api) this.#build(sp);
        else sp.api.layout(sp.el.clientWidth, sp.el.clientHeight, true);
        for (const p of sp.api?.panels ?? []) if (p.api.isVisible) this.#panels.get(p.id)?.def.onShow?.();
        this.#o.onSpaceShown?.(id);
    }

    /** Show the space that holds the panel and bring the panel to the front. */
    async reveal(panelId: string) {
        const sp = [...this.#spaces.values()].find((s) => s.def.panels.includes(panelId));
        if (!sp) return;
        await this.show(sp.def.id);
        sp.api?.getPanel(panelId)?.api.setActive();
    }

    /** Write pending changes now (window closes). */
    async flush() {
        if (!this.#saveTimer) return;
        clearTimeout(this.#saveTimer);
        this.#saveTimer = null;
        await this.#save();
    }

    #syncTabs() {
        for (const sp of this.#spaces.values()) {
            sp.tab.hidden = !isVisible(sp.def, this.#state);
            const on = sp.def.id === this.#state.active;
            sp.tab.classList.toggle('is-active', on);
            sp.tab.setAttribute('aria-selected', String(on));
            sp.tab.tabIndex = on ? 0 : -1;   // roving tabindex: one Tab stop for the tab list
        }
    }

    /** Arrow keys, Home and End move between the visible tabs and show the space (tabs pattern). */
    #onTabKey(e: KeyboardEvent) {
        const tabs = [...this.#spaces.values()].filter((s) => !s.tab.hidden);
        const i = tabs.findIndex((s) => s.tab === document.activeElement);
        if (i < 0) return;
        const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length
            : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
            : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (j < 0) return;
        e.preventDefault();
        tabs[j].tab.focus();
        void this.show(tabs[j].def.id);
    }

    #build(sp: SpaceRuntime) {
        const dv = this.#dv!;
        const api = dv.createDockview(sp.el, {
            theme: { ...dv.themeAbyss, name: 'signavis', className: 'dockview-theme-signavis', gap: 4 },
            disableFloatingGroups: true,
            createComponent: ({ id }) => this.#renderer(id),
        });
        sp.api = api;
        const stored = this.#state.spaces[sp.def.id]?.layout;
        // A panel belongs to the space that lists it, so restored and default layouts never share one.
        const own = new Set(sp.def.panels.filter((id) => this.#panels.has(id)));
        let restored = false;
        if (stored && layoutUsable(stored, own)) {
            try { api.fromJSON(stored as any); restored = api.panels.length > 0; }
            catch (e) { console.warn(`[spaces] layout of ${sp.def.id} not usable, using the default`, e); api.clear(); }
        }
        if (!restored) {
            let first: string | null = null;
            for (const id of own) {
                const p = this.#panels.get(id)!;
                api.addPanel({ id, component: id, title: p.def.title, ...(first ? { position: { referencePanel: first } } : {}) });
                first ??= id;
            }
            if (first) api.getPanel(first)?.api.setActive();
        }
        api.onDidLayoutChange(() => {
            (this.#state.spaces[sp.def.id] ??= { layout: null }).layout = api.toJSON();
            this.#scheduleSave();
        });
        api.onDidActivePanelChange(({ panel }) => { if (panel && !sp.el.hidden) this.#panels.get(panel.id)?.def.onShow?.(); });
    }

    #renderer(id: string): IContentRenderer {
        const p = this.#panels.get(id);
        if (!p) {
            const el = document.createElement('div');
            el.className = 'space-panel space-panel--missing';
            el.textContent = 'This panel is not available.';
            return { element: el, init() {} };
        }
        return {
            element: p.host,
            init: () => {
                if (p.mounted) return;
                p.mounted = true;
                p.def.mount(p.host);
            },
        };
    }

    #scheduleSave() {
        if (this.#saveTimer) clearTimeout(this.#saveTimer);
        this.#saveTimer = setTimeout(() => { this.#saveTimer = null; void this.#save(); }, SAVE_DELAY_MS);
    }

    async #save() {
        try { await this.#o.storage.save(stringifySpacesState(this.#state)); }
        catch (e) { console.warn('[spaces] cannot save the layout', e); }
    }
}
