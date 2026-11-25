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
    /** Bar above the spaces (the current view), in every space. */
    bar?: HTMLElement;
    /** After a space was shown (e.g. resize the player). */
    onSpaceShown?: (id: string) => void;
}

interface SpaceRuntime {
    def: SpaceDef;
    el: HTMLElement;
    tab: HTMLButtonElement;
    api: DockviewApi | null;
    /** Default layout built while hidden (eager): its sizes are applied when it is first shown. */
    sizesPending?: boolean;
    /** Folded groups (by group id) and the height each had before folding. */
    folded: Map<string, number>;
    /** Panels whose groups fold once the space is shown with a size. */
    foldPending?: string[];
}

/** Height of a folded group: its tab row plus the group border. */
const FOLDED_H = 32;
const UNFOLDED_MIN_H = 100;   // dockview's own minimum for a group

const SAVE_DELAY_MS = 600;

export class SpacesShell {
    readonly el: HTMLElement;
    #o: SpacesShellOptions;
    #state: SpacesState;
    #spaces = new Map<string, SpaceRuntime>();
    #panels = new Map<string, { def: PanelDef; host: HTMLElement; mounted: boolean; title: string }>();
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
            this.#panels.set(p.id, { def: p, host, mounted: false, title: p.title });
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
            this.#spaces.set(def.id, { def, el, tab, api: null, folded: new Map() });
        }
        if (o.bar) this.el.prepend(o.bar);
        o.replace.replaceWith(this.el);
        this.#syncTabs();
    }

    /**
     * Build the shell in place of `o.replace` and show the stored (or default) space.
     * On failure the page is left as it was (workspace back in place, no tabs) and the error is thrown.
     */
    static async create(o: SpacesShellOptions): Promise<SpacesShell> {
        let text: string | null = null;
        try { text = await o.storage.load(); } catch (e) { console.warn('[spaces] cannot read the layout', e); }
        const dv = await import('dockview-core');   // before anything in the page changes
        const shell = new SpacesShell(o, parseSpacesState(text, o.spaces, o.defaultActive));
        shell.#dv = dv;
        try {
            for (const id of o.eager ?? []) {
                const sp = shell.#spaces.get(id);
                if (sp && !sp.api) shell.#build(sp);
            }
            const first = shell.#spaces.get(shell.#state.active);
            await shell.show(first && isVisible(first.def, shell.#state) ? shell.#state.active : o.defaultActive);
        } catch (e) {
            shell.#undo();
            throw e;
        }
        return shell;
    }

    /** Put the replaced element back and remove the tabs (failed setup). */
    #undo() {
        for (const sp of this.#spaces.values()) { try { sp.api?.dispose(); } catch { /* half-built */ } }
        this.el.replaceWith(this.#o.replace);
        this.#tabs.remove();
    }

    get active(): string { return this.#state.active; }

    /** Spaces that can be shown now and their panels (for the Ctrl K search). */
    contents(): { spaces: { id: string; title: string }[]; panels: { id: string; title: string; space: string }[] } {
        const spaces: { id: string; title: string }[] = [];
        const panels: { id: string; title: string; space: string }[] = [];
        for (const sp of this.#spaces.values()) {
            if (sp.def.optional && !this.#state.spaces[sp.def.id]?.available) continue;
            spaces.push({ id: sp.def.id, title: sp.def.title });
            for (const id of sp.def.panels) {
                const p = this.#panels.get(id);
                if (p) panels.push({ id, title: p.def.title, space: sp.def.title });
            }
        }
        return { spaces, panels };
    }

    /** Put the view bar above the spaces later (the project got its catalog in this session). */
    setBar(el: HTMLElement) {
        this.el.querySelector(':scope > .view-bar')?.remove();
        this.el.prepend(el);
    }

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
        if (sp.sizesPending && sp.el.clientWidth > 0) { sp.sizesPending = false; this.#applySizes(sp); }
        if (sp.foldPending?.length && sp.el.clientWidth > 0) this.#applyPendingFolds(sp);
        for (const p of sp.api?.panels ?? []) if (p.api.isVisible) this.#panels.get(p.id)?.def.onShow?.();
        this.#o.onSpaceShown?.(id);
    }

    /** Show the space that holds the panel and bring the panel to the front. */
    async reveal(panelId: string) {
        const sp = [...this.#spaces.values()].find((s) => s.def.panels.includes(panelId));
        if (!sp) return;
        await this.show(sp.def.id);
        if (sp.api && !sp.api.getPanel(panelId)) this.#place(sp, panelId);
        const panel = sp.api?.getPanel(panelId);
        panel?.api.setActive();
        if (panel && sp.folded.has(panel.group.id)) this.#unfold(sp, panel.group);
    }

    /** Count or note after a panel's title in its tab (e.g. labels of the recording); '' removes it. */
    setBadge(panelId: string, text: string) {
        const p = this.#panels.get(panelId);
        if (!p) return;
        const title = text ? `${p.def.title} ${text}` : p.def.title;
        if (p.title === title) return;
        p.title = title;
        for (const sp of this.#spaces.values()) sp.api?.getPanel(panelId)?.api.setTitle(title);
    }

    /** Forget every stored layout and fold (spaces start with their standard layout after a reload). */
    async resetLayouts() {
        for (const st of Object.values(this.#state.spaces)) { st.layout = null; delete st.collapsed; }
        if (this.#saveTimer) { clearTimeout(this.#saveTimer); this.#saveTimer = null; }
        this.#resetting = true;   // the dock layouts still fire changes until the page goes
        await this.#save();
    }
    #resetting = false;

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
        const onDemand = new Set(sp.def.onDemand ?? []);
        let restored = false;
        if (stored && layoutUsable(stored, own, onDemand)) {
            try { api.fromJSON(stored as any); restored = api.panels.length > 0; }
            catch (e) { console.warn(`[spaces] layout of ${sp.def.id} not usable, using the default`, e); api.clear(); }
        }
        if (!restored) {
            let first: string | null = null;
            for (const id of own) {
                if (onDemand.has(id)) continue;
                this.#place(sp, id, first);
                first ??= id;
            }
            for (const id of sp.def.front ?? []) api.getPanel(id)?.api.setActive();
            if (first) api.getPanel(first)?.api.setActive();
            // Hidden (built eagerly): dockview splits a zero-size area evenly; set the sizes once it is shown.
            if (sp.el.clientWidth === 0) sp.sizesPending = true;
        }
        // Folding sets sizes: a space built while hidden (size 0) folds once it is shown.
        sp.foldPending = restored ? [...(this.#state.spaces[sp.def.id]?.collapsed ?? [])] : [...(sp.def.startCollapsed ?? [])];
        if (sp.el.clientWidth > 0) this.#applyPendingFolds(sp);
        this.#watchFoldClicks(sp);
        api.onDidLayoutChange(() => {
            (this.#state.spaces[sp.def.id] ??= { layout: null }).layout = api.toJSON();
            this.#scheduleSave();
        });
        api.onDidActivePanelChange(({ panel }) => { if (panel && !sp.el.hidden) this.#panels.get(panel.id)?.def.onShow?.(); });
    }

    /** Add a panel to the layout: by its `arrange` entry if that panel is placed, else as a tab next to `fallback`. */
    #place(sp: SpaceRuntime, id: string, fallback: string | null = sp.api?.panels[0]?.id ?? null) {
        const api = sp.api!;
        const p = this.#panels.get(id);
        if (!p) return;
        const at = sp.def.arrange?.[id];
        const ref = at && api.getPanel(at.ref) ? at : null;
        const size = ref?.size ? (ref.dir === 'left' || ref.dir === 'right' ? { initialWidth: ref.size } : { initialHeight: ref.size }) : {};
        api.addPanel({
            id, component: id, title: p.title,
            ...(ref ? { position: { referencePanel: ref.ref, direction: ref.dir }, ...size }
                : fallback ? { position: { referencePanel: fallback } } : {}),
        });
    }

    /** Group of a collapsible panel that holds `target` (a click in its tab row), else null. */
    #foldableGroupAt(sp: SpaceRuntime, target: EventTarget | null) {
        const el = target instanceof Element ? target : null;
        if (!el?.closest('.dv-tab') || !sp.api) return null;
        const g = sp.api.groups.find((x) => x.element.contains(el));
        return g && sp.def.collapsible?.some((c) => g.panels.some((p) => p.id === c)) ? g : null;
    }

    /** A click on the active tab folds its group; any tab of a folded group unfolds it. */
    #watchFoldClicks(sp: SpaceRuntime) {
        let before: { group: string; panel: string | undefined } | null = null;
        sp.el.addEventListener('pointerdown', (e) => {
            const g = this.#foldableGroupAt(sp, e.target);
            before = g ? { group: g.id, panel: g.activePanel?.id } : null;
        }, true);
        sp.el.addEventListener('click', (e) => {
            const g = this.#foldableGroupAt(sp, e.target);
            const was = before;
            before = null;
            if (!g || !was || was.group !== g.id) return;
            if (sp.folded.has(g.id)) this.#unfold(sp, g);
            else if (g.activePanel?.id === was.panel) this.#fold(sp, g);
        });
    }

    #fold(sp: SpaceRuntime, g: any, unfoldTo?: number) {
        if (sp.folded.has(g.id)) return;
        const h = g.api.height;
        sp.folded.set(g.id, unfoldTo ?? (h > FOLDED_H + 8 ? h : UNFOLDED_MIN_H * 3));
        g.element.classList.add('is-folded');
        g.api.setConstraints({ minimumHeight: FOLDED_H, maximumHeight: FOLDED_H });
        g.api.setSize({ height: FOLDED_H });
        this.#noteFolds(sp);
    }

    #unfold(sp: SpaceRuntime, g: any) {
        const h = sp.folded.get(g.id);
        if (h == null) return;
        sp.folded.delete(g.id);
        g.element.classList.remove('is-folded');
        g.api.setConstraints({ minimumHeight: UNFOLDED_MIN_H, maximumHeight: Number.MAX_SAFE_INTEGER });
        g.api.setSize({ height: h });
        this.#noteFolds(sp);
    }

    /** Fold the groups of the stored (or start) panels; only while the space has a size. */
    #applyPendingFolds(sp: SpaceRuntime) {
        const ids = sp.foldPending ?? [];
        sp.foldPending = undefined;
        for (const id of ids) {
            const g = sp.api?.getPanel(id)?.group;
            if (g && sp.def.collapsible?.some((c) => g.panels.some((p) => p.id === c))) this.#fold(sp, g, UNFOLDED_MIN_H * 3);
        }
    }

    #noteFolds(sp: SpaceRuntime) {
        const ids = [...sp.folded.keys()].flatMap((gid) => sp.api?.groups.find((x) => x.id === gid)?.panels.map((p) => p.id) ?? []);
        const st = (this.#state.spaces[sp.def.id] ??= { layout: null });
        if (ids.length) st.collapsed = ids; else delete st.collapsed;
        this.#scheduleSave();
    }

    /** Standard sizes of the arranged panels (after a build without a real size). */
    #applySizes(sp: SpaceRuntime) {
        for (const [id, at] of Object.entries(sp.def.arrange ?? {})) {
            if (!at.size) continue;
            const group = sp.api?.getPanel(id)?.group;
            if (!group) continue;
            group.api.setSize(at.dir === 'left' || at.dir === 'right' ? { width: at.size } : { height: at.size });
        }
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
        if (this.#resetting) return;
        if (this.#saveTimer) clearTimeout(this.#saveTimer);
        this.#saveTimer = setTimeout(() => { this.#saveTimer = null; void this.#save(); }, SAVE_DELAY_MS);
    }

    async #save() {
        try { await this.#o.storage.save(stringifySpacesState(this.#state)); }
        catch (e) { console.warn('[spaces] cannot save the layout', e); }
    }
}
