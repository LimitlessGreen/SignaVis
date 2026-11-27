// QuickLabelPicker.ts — quick species pick right at a newly drawn box (Lite, Annotate v2 mockup M1)
//
// A popover beside the box instead of the dialog in the middle: no backdrop, the box stays visible.
// Type to search, digits 1–9 pick, ↑ ↓ move, Enter saves, Esc cancels, Tab opens the full editor
// with what was typed. Results in three groups: in this recording, on the species list, all species.
// Sound type as chips (the other tags live in the full editor). "Keep for next labels" sets the template.

import type { SpeciesSuggestion } from '../taxonomy-ui/taxonomy-ui.ts';
import { normalizeSearch } from '../taxonomy-ui/species-ranking.ts';

export interface QuickPick {
    name: string;
    scientificName: string;
    color: string;
    tags: Record<string, string>;
    keepAsTemplate: boolean;
}

export interface QuickPickerOptions {
    /** Screen rectangle of the drawn box (the popover docks right of it, else left). */
    anchor: { left: number; top: number; right: number; bottom: number };
    /** Labels of this recording (name, colour, scientific name, tags). */
    existing: { name: string; color?: string; scientificName?: string; tags?: Record<string, string>; count?: number }[];
    /** Labels in this recording (group head "N labels"). */
    labelCount?: number;
    /** Name of the active species list (group head "Species list · name"). */
    listName?: string;
    /** Species search (the same provider as the label editor). */
    search: (query: string, limit: number) => SpeciesSuggestion[];
    /** Sound type options (tag preset `soundType`). */
    soundTypes: string[];
    initialSoundType?: string;
    offerTemplate?: boolean;
    onPick: (p: QuickPick) => void;
    /** Tab / "more…": the full editor with what was typed so far (`pick`: the highlighted row, or the typed text). */
    onMore: (query: string, soundType: string, pick: QuickPick | null) => void;
    onCancel: () => void;
}

interface Row { s: SpeciesSuggestion; group: string; hint: string }

const MAX_ROWS = 9;
const CHIP_COUNT = 4;

/** Rows of the three groups (max 9) and how many further matches did not fit. */
export function groupQuickRows(existing: QuickPickerOptions['existing'], found: SpeciesSuggestion[], query: string): Row[] & { more?: number } {
    const q = normalizeSearch(query).trim();
    const seen = new Set<string>();
    const key = (s: { name?: string; scientificName?: string }) => String(s.scientificName || s.name || '').trim().toLowerCase();
    const rows: Row[] & { more?: number } = [];
    let more = 0;
    // "unexpected here" only when the geo model knows the place (some match is local)
    const geoKnown = found.some((s) => s.local);
    const push = (s: SpeciesSuggestion, group: string, hint = '') => {
        const k = key(s);
        if (!k || seen.has(k)) return;
        seen.add(k);
        if (rows.length >= MAX_ROWS) { more += 1; return; }
        rows.push({ s, group, hint });
    };
    for (const e of existing) {
        if (q && !normalizeSearch(`${e.name} ${e.scientificName || ''}`).includes(q)) continue;
        const hint = [e.count ? `${e.count}×` : '', e.tags?.soundType || ''].filter(Boolean).join(' · ');
        push({ name: e.name, scientificName: e.scientificName || '', color: e.color || '', tags: e.tags || {} } as SpeciesSuggestion, 'recording', hint);
    }
    for (const s of found) if (s.group === 'project' || s.group === 'recent') push(s, 'recording', s.count ? `${s.count}× in project` : '');
    for (const s of found) if (s.listed && s.group !== 'project' && s.group !== 'recent') push(s, 'list');
    for (const s of found) {
        push(s, 'all', s.group === 'extra' ? 'not in BirdNET' : geoKnown && !s.local ? 'unexpected here' : '');
    }
    rows.more = more;
    return rows;
}

const GROUP_TITLE: Record<string, string> = { recording: 'In this recording', list: 'Species list', all: 'All species' };

export class QuickLabelPicker {
    readonly el = document.createElement('div');
    private input = document.createElement('input');
    private list = document.createElement('div');
    private rows: Row[] = [];
    private active = 0;
    private sound: string;
    private keep = false;
    private closed = false;
    private onDocDown = (e: PointerEvent) => { if (!this.el.contains(e.target as Node)) this.cancel(); };

    constructor(private o: QuickPickerOptions) {
        this.sound = o.initialSoundType || '';
    }

    open() {
        const el = this.el;
        el.className = 'quick-picker';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'New label');
        const head = document.createElement('div');
        head.className = 'qp-head';
        this.input.type = 'text';
        this.input.placeholder = 'Species…';
        this.input.setAttribute('aria-label', 'Species');
        const tab = document.createElement('span');
        tab.className = 'qp-key';
        tab.textContent = 'Tab = more fields';
        const icon = document.createElement('span');
        icon.className = 'qp-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
        head.append(icon, this.input, tab);
        this.list.className = 'qp-list';
        this.list.setAttribute('role', 'listbox');
        el.append(head, this.list, this.chips(), this.foot());
        document.body.append(el);
        this.render();
        this.place();
        this.input.addEventListener('input', () => { this.active = 0; this.render(); this.place(); });   // taller with more results: keep it on screen
        el.addEventListener('keydown', (e) => this.key(e));
        setTimeout(() => document.addEventListener('pointerdown', this.onDocDown, true), 0);
        this.input.focus();
    }

    private chips() {
        const row = document.createElement('div');
        row.className = 'qp-chips';
        const lab = document.createElement('span');
        lab.className = 'qp-chips-label';
        lab.textContent = 'Sound';
        row.append(lab);
        const opts = this.o.soundTypes.slice(0, CHIP_COUNT);
        if (this.sound && !opts.includes(this.sound)) opts.push(this.sound);
        for (const v of opts) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'qp-chip';
            b.textContent = v;
            b.setAttribute('aria-pressed', String(this.sound === v));
            b.onclick = () => {
                this.sound = this.sound === v ? '' : v;
                row.querySelectorAll<HTMLElement>('.qp-chip').forEach((c) => c.setAttribute('aria-pressed', String(c.textContent === this.sound)));
                this.input.focus();
            };
            row.append(b);
        }
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'qp-chip qp-chip--more';
        more.textContent = 'more…';
        more.title = 'All tags in the full editor (Tab)';
        more.onclick = () => this.more();
        row.append(more);
        return row;
    }

    private foot() {
        const f = document.createElement('div');
        f.className = 'qp-foot';
        if (this.o.offerTemplate) {
            const l = document.createElement('label');
            l.className = 'qp-keep';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.onchange = () => { this.keep = cb.checked; };
            l.append(cb, document.createTextNode(' Keep for next labels'));
            l.title = 'Becomes the label template: the next boxes get it without asking';
            f.append(l);
        }
        const hint = document.createElement('span');
        hint.className = 'qp-key';
        hint.textContent = '↑↓ 1–9';
        const esc = document.createElement('span');
        esc.className = 'qp-key';
        esc.textContent = 'Esc';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'qp-save';
        save.innerHTML = 'Save <span class="qp-key">Enter</span>';
        save.onclick = () => this.pick(this.active);
        f.append(hint, esc, save);
        return f;
    }

    private render() {
        const q = this.input.value;
        this.rows = groupQuickRows(this.o.existing, this.o.search(q, 24), q);
        const more = (this.rows as any).more || 0;
        this.list.replaceChildren();
        let last = '';
        const lastGroup = this.rows.length ? this.rows[this.rows.length - 1].group : '';
        this.rows.forEach((r, i) => {
            if (r.group !== last) {
                last = r.group;
                const h = document.createElement('div');
                h.className = 'qp-group';
                const title = r.group === 'list' && this.o.listName ? `Species list · ${this.o.listName}` : GROUP_TITLE[r.group];
                const right = r.group === 'recording' && this.o.labelCount ? `${this.o.labelCount} label${this.o.labelCount === 1 ? '' : 's'}`
                    : r.group === lastGroup && more ? `${more} more` : '';
                h.append(text('span', title), text('span', right, 'qp-group-r'));
                this.list.append(h);
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'qp-row' + (i === this.active ? ' active' : '');
            b.setAttribute('role', 'option');
            b.setAttribute('aria-selected', String(i === this.active));
            const sw = document.createElement('span');
            sw.className = 'qp-sw';
            if (r.s.color && r.group === 'recording') sw.style.background = r.s.color;
            b.append(text('span', String(i + 1), 'qp-num'), sw, mark(String(r.s.name), q, 'qp-name'));
            if (r.s.scientificName) b.append(text('small', String(r.s.scientificName), 'qp-sci'));
            b.append(text('span', r.hint, 'qp-hint'));
            b.onclick = () => this.pick(i);
            b.onpointerenter = () => this.highlight(i);
            this.list.append(b);
        });
        if (!this.rows.length) {
            const n = document.createElement('div');
            n.className = 'qp-none';
            n.textContent = q.trim() ? `No species found – Enter saves “${q.trim()}” as a free label` : 'Type a species name';
            this.list.append(n);
        }
    }

    private highlight(i: number) {
        this.active = i;
        this.list.querySelectorAll('.qp-row').forEach((r, k) => {
            r.classList.toggle('active', k === i);
            r.setAttribute('aria-selected', String(k === i));
        });
        this.list.querySelectorAll('.qp-row')[i]?.scrollIntoView({ block: 'nearest' });
    }

    private key(e: KeyboardEvent) {
        e.stopPropagation();   // the player's shortcuts stay quiet while picking
        if (e.key === 'Escape') { e.preventDefault(); this.cancel(); return; }
        if (e.key === 'Tab') { e.preventDefault(); this.more(); return; }
        if (e.key === 'Enter') { e.preventDefault(); this.pick(this.active); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (this.rows.length) this.highlight((this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.rows.length) % this.rows.length);
            return;
        }
        if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const i = Number(e.key) - 1;
            if (i < this.rows.length) { e.preventDefault(); this.pick(i); }
        }
    }

    /** What row `i` (or the typed text) would save. */
    private result(i: number): QuickPick | null {
        const r = this.rows[i];
        const free = this.input.value.trim();
        if (!r && !free) return null;
        const s = r?.s;
        const tags: Record<string, string> = { ...((s as any)?.tags || {}) };
        if (this.sound) tags.soundType = this.sound; else delete tags.soundType;
        return {
            name: s ? String(s.name) : free,
            scientificName: s ? String(s.scientificName || '') : '',
            color: s?.color || '',
            tags,
            keepAsTemplate: this.keep,
        };
    }

    private pick(i: number) {
        const res = this.result(i);
        if (!res) return;
        this.close();
        this.o.onPick(res);
    }

    private more() {
        const q = this.input.value;
        const res = this.result(this.active);
        this.close();
        this.o.onMore(q, this.sound, res);
    }

    cancel() {
        if (this.closed) return;
        this.close();
        this.o.onCancel();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        document.removeEventListener('pointerdown', this.onDocDown, true);
        this.el.remove();
    }

    /** Right of the box, else left; vertically aligned with its top, kept on screen. */
    private place() {
        const a = this.o.anchor;
        const w = this.el.offsetWidth || 420;
        const h = this.el.offsetHeight || 380;
        const gap = 12;
        const vw = window.innerWidth, vh = window.innerHeight;
        let x = a.right + gap;
        if (x + w > vw - 8) x = a.left - gap - w;
        if (x < 8) x = Math.max(8, Math.min(vw - w - 8, a.left));
        const y = Math.max(8, Math.min(vh - h - 8, a.top));
        this.el.style.left = `${Math.round(x)}px`;
        this.el.style.top = `${Math.round(y)}px`;
    }
}

function text(tag: string, t: string, cls = '') {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.textContent = t;
    return e;
}

/** The name with the typed part marked (first match, accents ignored by position only when lengths agree). */
function mark(name: string, q: string, cls: string) {
    const e = text('span', '', cls);
    const n = normalizeSearch(name), nq = normalizeSearch(q).trim();
    const i = nq && n.length === name.length ? n.indexOf(nq) : -1;
    if (i < 0) { e.textContent = name; return e; }
    const m = document.createElement('mark');
    m.textContent = name.slice(i, i + nq.length);
    e.append(name.slice(0, i), m, name.slice(i + nq.length));
    return e;
}
