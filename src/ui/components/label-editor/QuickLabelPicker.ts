// QuickLabelPicker.ts — quick species pick right at a newly drawn box (Lite, Annotate v2 mockup M1)
//
// A popover beside the box instead of the dialog in the middle: no backdrop, the box stays visible.
// Type to search, digits 1–9 pick, ↑ ↓ move, Enter saves, Esc cancels, Tab opens the full editor
// with what was typed. Results in three groups: in this recording, on the species list, all species.
// Sound type as chips (the other tags live in the full editor). "Keep for next labels" sets the template.

import { speciesRowHtml, type SpeciesSuggestion } from '../taxonomy-ui/taxonomy-ui.ts';
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
    existing: { name: string; color?: string; scientificName?: string; tags?: Record<string, string> }[];
    /** Species search (the same provider as the label editor). */
    search: (query: string, limit: number) => SpeciesSuggestion[];
    /** Sound type options (tag preset `soundType`). */
    soundTypes: string[];
    initialSoundType?: string;
    offerTemplate?: boolean;
    onPick: (p: QuickPick) => void;
    /** Tab / "more…": the full editor with what was typed so far. */
    onMore: (query: string, soundType: string) => void;
    onCancel: () => void;
}

interface Row { s: SpeciesSuggestion; group: string }

const MAX_ROWS = 9;
const CHIP_COUNT = 4;

export function groupQuickRows(existing: QuickPickerOptions['existing'], found: SpeciesSuggestion[], query: string): Row[] {
    const q = normalizeSearch(query).trim();
    const seen = new Set<string>();
    const key = (s: { name?: string; scientificName?: string }) => String(s.scientificName || s.name || '').trim().toLowerCase();
    const rows: Row[] = [];
    const push = (s: SpeciesSuggestion, group: string) => {
        const k = key(s);
        if (!k || seen.has(k) || rows.length >= MAX_ROWS) return;
        seen.add(k);
        rows.push({ s, group });
    };
    for (const e of existing) {
        if (q && !normalizeSearch(`${e.name} ${e.scientificName || ''}`).includes(q)) continue;
        push({ name: e.name, scientificName: e.scientificName || '', color: e.color || '', tags: e.tags || {} } as SpeciesSuggestion, 'recording');
    }
    for (const s of found) if (s.group === 'project' || s.group === 'recent') push(s, 'recording');
    for (const s of found) if (s.listed && s.group !== 'project' && s.group !== 'recent') push(s, 'list');
    for (const s of found) push(s, 'all');
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
        head.append(this.input, tab);
        this.list.className = 'qp-list';
        this.list.setAttribute('role', 'listbox');
        el.append(head, this.list, this.chips(), this.foot());
        document.body.append(el);
        this.render();
        this.place();
        this.input.addEventListener('input', () => { this.active = 0; this.render(); });
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
        hint.textContent = '↑↓ 1–9 · Esc';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'qp-save';
        save.innerHTML = 'Save <span class="qp-key">Enter</span>';
        save.onclick = () => this.pick(this.active);
        f.append(hint, save);
        return f;
    }

    private render() {
        const q = this.input.value;
        this.rows = groupQuickRows(this.o.existing, this.o.search(q, 14), q);
        this.list.replaceChildren();
        let last = '';
        this.rows.forEach((r, i) => {
            if (r.group !== last) {
                last = r.group;
                const h = document.createElement('div');
                h.className = 'qp-group';
                h.textContent = GROUP_TITLE[r.group];
                this.list.append(h);
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'qp-row species-search-item species-search-item--rich' + (i === this.active ? ' active' : '');
            b.setAttribute('role', 'option');
            b.setAttribute('aria-selected', String(i === this.active));
            b.innerHTML = `<span class="qp-num">${i + 1}</span>${speciesRowHtml(r.s, q)}`;
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

    private pick(i: number) {
        const r = this.rows[i];
        const free = this.input.value.trim();
        if (!r && !free) return;
        const s = r?.s;
        const tags: Record<string, string> = { ...((s as any)?.tags || {}) };
        if (this.sound) tags.soundType = this.sound; else delete tags.soundType;
        const res: QuickPick = {
            name: s ? String(s.name) : free,
            scientificName: s ? String(s.scientificName || '') : '',
            color: s?.color || '',
            tags,
            keepAsTemplate: this.keep,
        };
        this.close();
        this.o.onPick(res);
    }

    private more() {
        const q = this.input.value;
        this.close();
        this.o.onMore(q, this.sound);
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
