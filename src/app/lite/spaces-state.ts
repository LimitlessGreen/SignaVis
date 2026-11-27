// ═══════════════════════════════════════════════════════════════════════
// app/lite/spaces-state.ts — what SignaVis Lite stores about its spaces
//
// A space is a tab at the top (Browse, Annotate, Embeddings, …) with its own
// panel layout. Stored per project in .signavis/spaces.json (folder
// projects) or in the prefs (default project). Pure functions, no DOM.
// ═══════════════════════════════════════════════════════════════════════

export interface SpaceDef {
    id: string;
    title: string;
    /** Inline SVG (lucide-static). */
    icon: string;
    /** Panels of a fresh layout, as tabs of one group, the first one active. */
    panels: string[];
    /** Hidden until something says it is useful (Embeddings: once embeddings exist). */
    optional?: boolean;
    /**
     * Fresh layout: where a panel goes relative to one placed before it (default: a tab next to the
     * previous one). Panels are placed in `panels` order; size in px across the split.
     */
    arrange?: Record<string, PanelPlacement>;
    /** Fresh layout: panels brought to the front of their tab group (default: the first panel). */
    front?: string[];
    /**
     * Panels of this space left out of a fresh layout; placed (by `arrange`) the first time they are
     * revealed, and then stored like the others. A stored layout may lack them.
     */
    onDemand?: string[];
    /**
     * Panels whose tab group folds to its tab row: a click on the active tab folds or unfolds it
     * (mockup B6: Analyse | Similar | Species | Upload below the right panels).
     */
    collapsible?: string[];
    /** Fresh layout: the groups of these panels start folded. */
    startCollapsed?: string[];
}

export interface PanelPlacement {
    ref: string;
    dir: 'left' | 'right' | 'above' | 'below' | 'within';
    size?: number;
}

export interface StoredSpace {
    /** Dockview layout (DockviewApi.toJSON()); null: the default layout. */
    layout: unknown | null;
    /** Optional space that was made available once (stays, so the tab does not jump in and out). */
    available?: boolean;
    /** Panels of folded groups (dockview stores sizes, not the fold, so it is kept here). */
    collapsed?: string[];
}

export interface SpacesState {
    version: 1;
    active: string;
    spaces: Record<string, StoredSpace>;
}

export const SPACES_FILE = '.signavis/spaces.json';

export function emptyState(active: string): SpacesState {
    return { version: 1, active, spaces: {} };
}

/** Parse stored text; anything unreadable gives the empty state (never throws). */
export function parseSpacesState(text: string | null | undefined, defs: readonly SpaceDef[], fallbackActive: string): SpacesState {
    const state = emptyState(fallbackActive);
    if (!text) return state;
    let raw: any;
    try { raw = JSON.parse(text); } catch { return state; }
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return state;
    const ids = new Set(defs.map((d) => d.id));
    if (raw.spaces && typeof raw.spaces === 'object') {
        for (const [id, s] of Object.entries<any>(raw.spaces)) {
            if (!ids.has(id) || !s || typeof s !== 'object') continue;
            const collapsed = Array.isArray(s.collapsed) ? s.collapsed.filter((x: unknown) => typeof x === 'string') : [];
            state.spaces[id] = {
                layout: isLayout(s.layout) ? s.layout : null,
                ...(s.available === true ? { available: true } : {}),
                ...(collapsed.length ? { collapsed } : {}),
            };
        }
    }
    if (typeof raw.active === 'string' && ids.has(raw.active)) state.active = raw.active;
    return state;
}

/** A dockview layout has a grid and a panels map; anything else is dropped. */
function isLayout(v: any): boolean {
    return !!v && typeof v === 'object' && !!v.grid && typeof v.grid === 'object' && !!v.panels && typeof v.panels === 'object';
}

export function stringifySpacesState(state: SpacesState): string {
    return `${JSON.stringify(state, null, 1)}\n`;
}

/** Panel ids a stored layout uses (dockview `panels` map), in no particular order. */
export function layoutPanelIds(layout: unknown): string[] {
    const panels = (layout as any)?.panels;
    return panels && typeof panels === 'object' ? Object.keys(panels) : [];
}

/**
 * A stored layout is only used when every panel in it belongs to this space
 * (a panel's element can live in one place only), every entry names the
 * panel it is stored under (dockview restores an entry by its own `id` and
 * `contentComponent`, not by the map key), and it holds every panel of the
 * space: panels cannot be closed yet, so a missing one is new (an update)
 * and would otherwise never appear. Panels in `onDemand` may be missing
 * (they are added when revealed).
 */
export function layoutUsable(layout: unknown, own: ReadonlySet<string>, onDemand: ReadonlySet<string> = new Set()): boolean {
    const panels = (layout as any)?.panels;
    if (!panels || typeof panels !== 'object') return false;
    const entries = Object.entries<any>(panels);
    if ([...own].some((id) => !(id in panels) && !onDemand.has(id))) return false;
    return entries.length > 0 && entries.every(([key, e]) =>
        own.has(key) && !!e && typeof e === 'object' && e.id === key
        && (e.contentComponent === undefined || e.contentComponent === key));
}

export function isVisible(def: SpaceDef, state: SpacesState): boolean {
    return !def.optional || state.spaces[def.id]?.available === true;
}
