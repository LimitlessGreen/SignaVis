// ═══════════════════════════════════════════════════════════════════════
// app/lite/command-search.ts — what the Ctrl K search finds (Lite, Annotate v2 mockup B3)
//
// One search for species (Enter = label template), recordings, and actions & panels.
// Pure: species and recordings come in already found (the app asks the taxonomy and the
// catalog); actions are a list built from the app's state, ranked here by the query.
// The palette UI (ui/components/command-palette) shows the sections in this order.
// ═══════════════════════════════════════════════════════════════════════

import { normalizeSearch } from '../../ui/components/taxonomy-ui/species-ranking.ts';
import type { MenuEntry } from './top-menus.ts';

export type PaletteGroup = 'species' | 'recordings' | 'actions';

export interface PaletteItem {
    /** What the app runs on Enter (e.g. `species:Glaucidium passerinum`, `panel:labels`, `project:rescan`). */
    id: string;
    group: PaletteGroup;
    label: string;
    /** Grey text after the label (scientific name, site, "add to this space"). */
    sub?: string;
    /** Right-hand key hint (B, D, Ctrl O, "Enter = label template"). */
    hint?: string;
    /** Swatch colour (species). */
    color?: string;
    /** Icon name the UI knows (wave, panel, space, run, gear, filter, …). */
    icon?: string;
    /** Further words the item is found by (not shown). */
    keywords?: string;
    /** Alt+Enter on a species: this item's id instead (filter chip). */
    altId?: string;
    /** A species the user works with (in the project, recently used or on the species list). */
    familiar?: boolean;
}

export interface PaletteSection { group: PaletteGroup; heading: string; items: PaletteItem[] }

const HEADINGS: Record<PaletteGroup, string> = { species: 'Species', recordings: 'Recordings', actions: 'Actions & panels' };

/**
 * How well `text` matches `query`: 0 = not every word found; higher is better.
 * Per query word: 3 = the text starts with it, 2 = a word of the text starts with it, 1 = inside a word.
 */
export function matchScore(query: string, text: string): number {
    const words = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 1;
    const t = normalizeSearch(text);
    let score = 0;
    for (const w of words) {
        const i = t.indexOf(w);
        if (i < 0) return 0;
        if (i === 0) score += 3;
        else if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}`, 'u').test(t)) score += 2;
        else score += 1;
    }
    return score;
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Actions matching the query, best first (label weighs more than sub/keywords); stable for ties. */
export function rankActions(items: PaletteItem[], query: string, limit = 8): PaletteItem[] {
    if (!normalizeSearch(query).trim()) return items.slice(0, limit);
    return items
        .map((it, i) => {
            const onLabel = matchScore(query, it.label);
            const any = onLabel || matchScore(query, `${it.label} ${it.sub || ''} ${it.keywords || ''}`);
            return { it, i, s: onLabel ? onLabel * 2 : any };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, limit)
        .map((x) => x.it);
}

/** The sections to show: species and recordings as found (empty query: only actions), then the ranked actions. */
export function paletteSections(found: { species?: PaletteItem[]; recordings?: PaletteItem[] }, actions: PaletteItem[], query: string,
    limits: { species?: number; recordings?: number; actions?: number } = {}): PaletteSection[] {
    const q = normalizeSearch(query).trim();
    const out: PaletteSection[] = [];
    const add = (group: PaletteGroup, items: PaletteItem[]) => { if (items.length) out.push({ group, heading: HEADINGS[group], items }); };
    const ranked = rankActions(actions, query, limits.actions ?? (q ? 6 : 10));
    // "dark" → "Dark theme" before far-away species like "Dark Batis"; familiar species stay first.
    const words = q.split(/\s+/).filter(Boolean).length;
    const species = (found.species || []).slice(0, limits.species ?? 4);
    const actionsFirst = !!q && !!ranked[0] && matchScore(query, ranked[0].label) >= 3 * words && !species[0]?.familiar;
    if (actionsFirst) add('actions', ranked);
    if (q) {
        add('species', species);
        add('recordings', (found.recordings || []).slice(0, limits.recordings ?? 5));
    }
    if (!actionsFirst) add('actions', ranked);
    return out;
}

/** All items of the sections in display order (the keyboard walks these). */
export function flatItems(sections: PaletteSection[]): PaletteItem[] {
    return sections.flatMap((s) => s.items);
}

/** Species found by the taxonomy as palette items (Enter = label template, Alt+Enter = filter when `filterable`). */
export function speciesItems(found: { name: string; scientificName?: string; color?: string; count?: number; group?: string; listed?: boolean }[],
    filterable: (scientificName: string, name: string) => boolean): PaletteItem[] {
    const seen = new Set<string>();
    const out: PaletteItem[] = [];
    for (const s of found) {
        const key = (s.scientificName || s.name || '').trim();
        if (!key || seen.has(key.toLowerCase())) continue;
        seen.add(key.toLowerCase());
        const sub = [s.scientificName && s.scientificName !== s.name ? s.scientificName : '', s.count ? `${s.count} labels` : ''].filter(Boolean).join(' · ');
        out.push({
            id: `species:${key}`, group: 'species', label: s.name || key, sub, color: s.color,
            familiar: s.group === 'project' || s.group === 'recent' || !!s.listed,
            ...(filterable(s.scientificName || '', s.name) ? { altId: `filter-species:${key}` } : {}),
        });
    }
    // The first match also offers the filter as its own row (as in the mockup).
    if (out[0]?.altId) {
        out.splice(1, 0, { id: out[0].altId, group: 'species', label: `Filter view: detected ${out[0].label}`, sub: '→ chip', color: out[0].color, icon: 'filter' });
    }
    if (out[0]) out[0].hint = 'Enter = label template';
    return out;
}

/**
 * The catalog's detection class for a species (classes come from imported tables: scientific name,
 * common name, BirdNET's "Scientific_Common", or an eBird code such as "eurbla"). Case-insensitive;
 * null when none fits.
 */
export function detectionClassFor(classes: string[], scientificName: string, name: string, code = ''): string | null {
    const sci = scientificName.trim().toLowerCase();
    const com = name.trim().toLowerCase();
    const ebird = code.trim().toLowerCase();
    for (const c of classes) {
        const k = c.trim().toLowerCase();
        if (!k) continue;
        if (ebird && k === ebird) return c;
        if (sci && (k === sci || k.startsWith(`${sci}_`))) return c;
        if (com && (k === com || k.endsWith(`_${com}`))) return c;
    }
    return null;
}

export interface PaletteContext {
    /** Spaces that can be shown now (id, title) and the active one. */
    spaces: { id: string; title: string }[];
    activeSpace: string;
    /** Panels of the spaces (id, title, space title). */
    panels: { id: string; title: string; space: string }[];
    /** A recording of the catalog view is open in Annotate (Mark done, next / previous follow the view). */
    inView: boolean;
    hasRecording: boolean;
    canAnalyze: boolean;
    /** The Project ▾ and ⚙ menus, as built for the top bar (their ids are reused). */
    projectMenu: MenuEntry[];
    settingsMenu: MenuEntry[];
}

/** Everything the palette can do besides species and recordings. */
export function paletteActions(c: PaletteContext): PaletteItem[] {
    const a: PaletteItem[] = [];
    if (c.hasRecording) {
        if (c.canAnalyze) a.push({ id: 'run-birdnet', group: 'actions', label: 'Run BirdNET on this recording', hint: 'B', icon: 'run', keywords: 'analyse analyze detect' });
        if (c.inView) a.push({ id: 'mark-done', group: 'actions', label: 'Mark done', sub: 'and open the next', hint: 'D', icon: 'check', keywords: 'review finished' });
        a.push({ id: 'next-recording', group: 'actions', label: 'Next recording', hint: 'N', icon: 'wave' });
        a.push({ id: 'prev-recording', group: 'actions', label: 'Previous recording', hint: 'P', icon: 'wave' });
    }
    for (const s of c.spaces) {
        if (s.id === c.activeSpace) continue;
        a.push({ id: `space:${s.id}`, group: 'actions', label: `Go to ${s.title}`, sub: 'space', icon: 'space' });
    }
    for (const p of c.panels) a.push({ id: `panel:${p.id}`, group: 'actions', label: `Panel: ${p.title}`, sub: p.space, icon: 'panel' });
    const fromMenu = (prefix: string, entries: MenuEntry[], icon: string) => {
        let heading = '';
        for (const e of entries) {
            if (e.heading) heading = e.heading;
            if (!e.id || !e.label || e.disabled || e.more && prefix === 'settings') continue;
            a.push({ id: `${prefix}:${e.id}`, group: 'actions', label: e.label.replace(/…$/, ''), sub: heading,
                hint: e.checked != null ? (e.checked ? 'on' : 'off') : undefined, icon, keywords: e.hint });
        }
    };
    fromMenu('project', c.projectMenu, 'folder');
    fromMenu('settings', c.settingsMenu, 'gear');
    a.push({ id: 'shortcuts', group: 'actions', label: 'Keyboard shortcuts', hint: '?', icon: 'keyboard', keywords: 'help keys' });
    return a;
}
