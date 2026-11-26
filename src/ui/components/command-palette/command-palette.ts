// command-palette.ts — the Ctrl K search (Lite, Annotate v2 mockup B3 `.pal`)
//
// A box near the top of the window: one input, results in sections (Species, Recordings,
// Actions & panels), ↑ ↓ move, Enter runs, Alt+Enter runs a species' filter instead,
// Esc or a click outside closes. What is found and what runs comes from the app
// (`find`, `run`); this file only shows and steers. Recordings may arrive later (async).

import { Search, AudioLines, PanelsTopLeft, LayoutGrid, Sparkles, Check, Folder, Settings, Keyboard, Filter, Library } from 'lucide-static';
import { paletteSections, flatItems, type PaletteItem, type PaletteSection } from '../../../app/lite/command-search.ts';

const ICONS: Record<string, string> = {
    wave: AudioLines, panel: PanelsTopLeft, space: LayoutGrid, run: Sparkles, check: Check,
    folder: Folder, gear: Settings, keyboard: Keyboard, filter: Filter, xc: Library,
};

export interface CommandPaletteOptions {
    /** Species for the query (sync, from the taxonomy). */
    species: (query: string) => PaletteItem[];
    /** Recordings for the query (may be async: catalog). */
    recordings: (query: string) => PaletteItem[] | Promise<PaletteItem[]>;
    /** Actions & panels (built fresh when the palette opens). */
    actions: () => PaletteItem[];
    /** Run an item's id; the palette is closed before. */
    run: (id: string, item: PaletteItem) => void;
}

const RECORDING_DELAY_MS = 120;

export class CommandPalette {
    readonly el = document.createElement('div');
    private input = document.createElement('input');
    private list = document.createElement('div');
    private sections: PaletteSection[] = [];
    private items: PaletteItem[] = [];
    private actions: PaletteItem[] = [];
    private recordings: PaletteItem[] = [];
    private recFor = '';
    private recTimer: ReturnType<typeof setTimeout> | null = null;
    private seq = 0;
    private active = 0;
    private restoreFocus: HTMLElement | null = null;
    private onDocDown = (e: PointerEvent) => { if (!this.el.contains(e.target as Node)) this.close(); };

    constructor(private o: CommandPaletteOptions) {
        const el = this.el;
        el.className = 'command-palette';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Search species, recordings and actions');
        el.dataset.awOwnKeys = '';
        el.hidden = true;
        const head = document.createElement('div');
        head.className = 'cp-head';
        const icon = document.createElement('span');
        icon.className = 'cp-icon';
        icon.innerHTML = Search;
        this.input.type = 'text';
        this.input.placeholder = 'Species, recordings, actions…';
        this.input.setAttribute('aria-label', 'Search');
        this.input.setAttribute('role', 'combobox');
        this.input.setAttribute('aria-controls', 'cpList');
        this.input.setAttribute('aria-expanded', 'true');
        this.input.spellcheck = false;
        const esc = document.createElement('span');
        esc.className = 'cp-key';
        esc.textContent = 'Esc';
        head.append(icon, this.input, esc);
        this.list.className = 'cp-list';
        this.list.id = 'cpList';
        this.list.setAttribute('role', 'listbox');
        const foot = document.createElement('div');
        foot.className = 'cp-foot';
        foot.innerHTML = '<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Alt</kbd>+<kbd>Enter</kbd> species as filter</span>';
        el.append(head, this.list, foot);
        this.input.addEventListener('input', () => { this.active = 0; this.refresh(); });
        el.addEventListener('keydown', (e) => this.key(e));
        this.list.addEventListener('pointermove', (e) => {
            const row = (e.target as Element).closest<HTMLElement>('.cp-row');
            if (row && Number(row.dataset.i) !== this.active) { this.active = Number(row.dataset.i); this.mark(); }
        });
        this.list.addEventListener('click', (e) => {
            const row = (e.target as Element).closest<HTMLElement>('.cp-row');
            if (row) this.runAt(Number(row.dataset.i), e.altKey);
        });
    }

    get isOpen() { return !this.el.hidden; }

    open(query = '') {
        if (!this.el.isConnected) document.body.append(this.el);
        if (!this.isOpen) this.restoreFocus = document.activeElement as HTMLElement | null;
        this.actions = this.o.actions();
        this.el.hidden = false;
        this.input.value = query;
        this.input.select();
        this.active = 0;
        this.recordings = [];
        this.recFor = '';
        this.refresh();
        this.input.focus();
        setTimeout(() => document.addEventListener('pointerdown', this.onDocDown, true), 0);
    }

    close() {
        if (!this.isOpen) return;
        this.el.hidden = true;
        this.seq++;
        if (this.recTimer) clearTimeout(this.recTimer);
        document.removeEventListener('pointerdown', this.onDocDown, true);
        const back = this.restoreFocus;
        this.restoreFocus = null;
        if (back?.isConnected) back.focus({ preventScroll: true });
    }

    toggle() { if (this.isOpen) this.close(); else this.open(); }

    private refresh() {
        const q = this.input.value;
        // Recordings of an older query are kept until the new ones arrive only while they still match the start.
        if (!q.trim() || !q.toLowerCase().startsWith(this.recFor.toLowerCase()) || !this.recFor) this.recordings = [];
        this.render();
        if (this.recTimer) clearTimeout(this.recTimer);
        if (!q.trim()) return;
        const seq = ++this.seq;
        this.recTimer = setTimeout(async () => {
            let found: PaletteItem[] = [];
            try { found = await this.o.recordings(q); } catch (e) { console.warn('[palette] recordings', e); }
            if (seq !== this.seq || !this.isOpen) return;
            this.recordings = found;
            this.recFor = q;
            const keep = this.items[this.active]?.id;
            this.render();
            const i = this.items.findIndex((it) => it.id === keep);
            if (i >= 0) { this.active = i; this.mark(); }
        }, RECORDING_DELAY_MS);
    }

    private render() {
        const q = this.input.value;
        let species: PaletteItem[] = [];
        try { species = q.trim() ? this.o.species(q) : []; } catch (e) { console.warn('[palette] species', e); }
        this.sections = paletteSections({ species, recordings: this.recordings }, this.actions, q);
        this.items = flatItems(this.sections);
        if (this.active >= this.items.length) this.active = Math.max(0, this.items.length - 1);
        this.list.replaceChildren();
        if (!this.items.length) {
            const none = document.createElement('div');
            none.className = 'cp-none';
            none.textContent = 'Nothing found';
            this.list.append(none);
            this.input.removeAttribute('aria-activedescendant');
            return;
        }
        let i = 0;
        for (const s of this.sections) {
            const h = document.createElement('div');
            h.className = 'cp-group';
            h.textContent = s.heading;
            h.setAttribute('role', 'presentation');
            this.list.append(h);
            for (const it of s.items) this.list.append(this.row(it, i++));
        }
        this.mark();
    }

    private row(it: PaletteItem, i: number) {
        const r = document.createElement('div');
        r.className = 'cp-row';
        r.id = `cpRow${i}`;
        r.dataset.i = String(i);
        r.setAttribute('role', 'option');
        if (it.color && it.icon !== 'filter' || it.group === 'species' && !it.icon) {
            const sw = document.createElement('span');
            sw.className = 'cp-swatch';
            if (it.color) sw.style.background = it.color;
            r.append(sw);
        } else {
            const ic = document.createElement('span');
            ic.className = 'cp-icon';
            ic.innerHTML = ICONS[it.icon || (it.group === 'recordings' ? 'wave' : 'panel')] || '';
            r.append(ic);
        }
        const label = document.createElement('span');
        label.className = 'cp-label';
        label.textContent = it.label;
        r.append(label);
        if (it.sub) {
            const sub = document.createElement('small');
            sub.textContent = it.sub;
            r.append(sub);
        }
        if (it.hint) {
            const k = document.createElement('span');
            k.className = 'cp-key';
            k.textContent = it.hint;
            r.append(k);
        }
        return r;
    }

    private mark() {
        this.list.querySelectorAll<HTMLElement>('.cp-row').forEach((r) => {
            const on = Number(r.dataset.i) === this.active;
            r.classList.toggle('is-active', on);
            r.setAttribute('aria-selected', String(on));
            if (on) {
                this.input.setAttribute('aria-activedescendant', r.id);
                r.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    private key(e: KeyboardEvent) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = this.items.length;
            if (n) this.active = (this.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
            this.mark();
            return;
        }
        if (e.key === 'Enter') { e.preventDefault(); this.runAt(this.active, e.altKey); return; }
        // Keep the app's shortcuts out while typing here (Space would play, digits set sound types).
        e.stopPropagation();
    }

    private runAt(i: number, alt: boolean) {
        const it = this.items[i];
        if (!it) return;
        const id = alt && it.altId ? it.altId : it.id;
        this.close();
        this.o.run(id, it);
    }
}
