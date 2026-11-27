// label-fields-form.ts — the fields of one label in sections (Annotate v2 mockup M2, right side)
//
// LABEL (species, presence, colour) · TAGS (presets as buttons, own tags as chips) ·
// XENO-CANTO ANNOTA (domain/labelFields.ts) · BOX (start/end/low/high, Box | Time only, channel) · SOURCE.
// Every change goes out at once through `change(updates)` (no Save). Read-only labels show values only.

import { ANNOTA_FIELDS, toYN } from '../../../domain/labelFields.ts';
import { colorForName } from '../../../domain/annotations.ts';

export interface TagPreset { key: string; label: string; options: string[] }

export interface FieldsFormOptions {
    /** Apply these updates to the label now. */
    change: (updates: Record<string, any>) => void;
    /** Species search widget (the app's taxonomy search); null: plain text field. */
    speciesSearch?: ((onSelect: (s: { name: string; scientificName?: string }) => void) => { el: HTMLElement; input: HTMLInputElement; destroy?: () => void }) | null;
    tagPresets: TagPreset[];
    /** Clock time of a recording offset ("21:31:12.40"); null: seconds. */
    clock?: ((sec: number) => string) | null;
    /** Channels of the recording (2 = L/R/Mix shown). */
    channels: number;
    /** Text for the SOURCE section. */
    source: (label: any) => { from: string; author: string; history?: number };
    /** Signal-to-noise text ("12.3 dB", "Computing…"); default: the label's stored `snr`. */
    snr?: (label: any) => string;
    /** "History (n)" link. */
    showHistory?: () => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};

/** Buttons in one frame, one of them on (or none). */
function seg(options: { value: string; text: string; tone?: 'ok' | 'no' }[], value: string, pick: (v: string) => void, disabled = false) {
    const s = el('span', 'lf-seg');
    for (const o of options) {
        const on = o.value === value && value !== '';
        const b = el('button', 'lf-seg-b' + (on ? ' on' : '') + (o.tone && on ? ` ${o.tone}` : ''), o.text);
        b.type = 'button';
        b.disabled = disabled;
        b.setAttribute('aria-pressed', String(on));
        b.onclick = () => pick(o.value);
        s.append(b);
    }
    return s;
}

export class LabelFieldsForm {
    readonly el = el('div', 'lf-form');
    private label: any = null;
    private collapsed = new Set<string>(['annota-more']);
    private widgets: { destroy?: () => void }[] = [];

    constructor(private o: FieldsFormOptions) {}

    /**
     * The label changed while a field has focus (the form is not drawn again then): keep its newest
     * state, so a tag edit starts from it and does not undo a change made elsewhere meanwhile.
     */
    track(label: any) { if (label) this.label = label; }

    /** One tag changed, on top of the label's current tags (not the ones seen when the form was drawn). */
    private setTag(k: string, v: string) {
        const next = { ...(this.label?.tags || {}) };
        if (v) next[k] = v; else delete next[k];
        this.o.change({ tags: next });
    }

    render(label: any) {
        this.label = label;
        for (const w of this.widgets) w.destroy?.();
        this.widgets = [];
        const ro = label?.readonly === true;
        this.el.replaceChildren();
        if (!label) return;
        this.el.append(this.sectionLabel(label, ro), this.sectionTags(label, ro), this.sectionAnnota(label, ro),
            this.sectionBox(label, ro), this.sectionSource(label));
    }

    destroy() { for (const w of this.widgets) w.destroy?.(); this.widgets = []; }

    private section(id: string, title: string, right?: HTMLElement | null) {
        const s = el('section', 'lf-sec');
        const h = el('h4', 'lf-h');
        const car = el('span', 'lf-car', this.collapsed.has(id) ? '▸' : '▾');
        h.append(car, el('span', '', title));
        if (right) { right.classList.add('lf-h-r'); h.append(right); }
        h.onclick = (e) => {
            if ((e.target as HTMLElement).closest('.lf-h-r')) return;
            if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
            this.render(this.label);
        };
        s.append(h);
        if (this.collapsed.has(id)) s.classList.add('collapsed');
        return s;
    }

    private row(name: string, ...content: (Node | string)[]) {
        const r = el('div', 'lf-row');
        r.append(el('span', 'lf-name', name));
        const v = el('div', 'lf-val');
        v.append(...content);
        r.append(v);
        return r;
    }

    // ── LABEL ──
    private sectionLabel(l: any, ro: boolean) {
        const s = this.section('label', 'Label');
        const sw = () => { const d = el('span', 'lf-sw'); d.style.background = l.color || colorForName(l.label || ''); return d; };
        let species: HTMLElement;
        if (!ro && this.o.speciesSearch) {
            const w = this.o.speciesSearch(({ name, scientificName }) => {
                // colour follows the species unless the label has its own (custom…)
                this.o.change({ label: name, scientificName: scientificName || '', commonName: '',
                    ...(l.colorCustom ? {} : { color: colorForName(name) }) });
            });
            this.widgets.push(w);
            w.input.value = l.label || '';
            species = el('div', 'lf-inp lf-species');
            const sci = el('small', '', l.scientificName || '');
            species.append(sw(), w.el, sci, el('span', 'lf-caret', '▾'));
        } else {
            species = el('div', 'lf-inp lf-species');
            species.append(sw(), el('span', '', l.label || '–'), el('small', '', l.scientificName || ''));
        }
        s.append(this.row('Species', species));
        s.append(this.row('Presence', seg([
            { value: 'present', text: 'Present', tone: 'ok' },
            { value: 'absent', text: 'Absent', tone: 'no' },
        ], l.polarity === 'absent' ? 'absent' : 'present',
        (v) => this.o.change({ polarity: v === 'absent' ? 'absent' : undefined }), ro)));
        const color = el('span', 'lf-color');
        const fromSpecies = !l.colorCustom;
        const own = colorForName(l.label || '');
        const dot = el('span', 'lf-sw');
        dot.style.background = l.color || own;
        const custom = el('label', 'lf-custom', fromSpecies ? '· custom… ▾' : '· custom ▾');
        const pick = el('input');
        pick.type = 'color';
        pick.value = /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '#38bdf8';
        pick.disabled = ro;
        pick.onchange = () => this.o.change({ color: pick.value, colorCustom: true });
        custom.append(pick);
        const back = el('button', 'lf-link', fromSpecies ? 'from species' : 'back to species colour');
        back.type = 'button';
        back.disabled = ro || fromSpecies;
        back.onclick = () => this.o.change({ color: own, colorCustom: undefined });
        color.append(dot, back, custom);
        s.append(this.row('Color', color));
        return s;
    }

    // ── TAGS ──
    private sectionTags(l: any, ro: boolean) {
        const tags: Record<string, string> = { ...(l.tags || {}) };
        const add = el('button', 'lf-link', '+ tag');
        add.type = 'button';
        add.disabled = ro;
        add.onclick = () => this.addCustomTag(s);
        const s = this.section('tags', 'Tags', add);
        const setTag = (k: string, v: string) => this.setTag(k, v);
        // mockup order: sound type first; names as words ("Life stage", not "lifeStage")
        const nice = (p: TagPreset) => (p.label && p.label !== p.key ? p.label
            : p.key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c) => ` ${c.toLowerCase()}`));
        const presets = [...this.o.tagPresets].sort((a, b) => Number(b.key === 'soundType') - Number(a.key === 'soundType'));
        for (const p of presets) {
            const cur = tags[p.key] || '';
            if (p.key === 'soundType') {
                const chips = el('div', 'lf-chips');
                for (const v of p.options.slice(0, 5)) {
                    const c = el('button', 'lf-chip' + (cur === v ? ' on' : ''), v);
                    c.type = 'button';
                    c.disabled = ro;
                    c.onclick = () => setTag(p.key, cur === v ? '' : v);
                    chips.append(c);
                }
                if (cur && !p.options.slice(0, 5).includes(cur)) {
                    const c = el('button', 'lf-chip on', cur);
                    c.type = 'button';
                    c.onclick = () => setTag(p.key, '');
                    chips.append(c);
                }
                const more = el('select', 'lf-chip lf-chip-add');
                more.disabled = ro;
                more.title = 'More sound types';
                more.append(new Option('+', ''));
                for (const v of p.options.slice(5)) more.append(new Option(v, v));
                more.onchange = () => { if (more.value) setTag(p.key, more.value); };
                chips.append(more);
                s.append(this.row(nice(p), chips));
            } else {
                const opts = p.options.slice(0, 3).map((v) => ({ value: v, text: v }));
                if (cur && !opts.some((o) => o.value === cur)) opts.push({ value: cur, text: cur });
                opts.push({ value: '', text: '–' });
                s.append(this.row(nice(p), seg(opts, cur, (v) => setTag(p.key, v), ro)));
            }
        }
        const preset = new Set([...this.o.tagPresets.map((p) => p.key), ...ANNOTA_FIELDS.map((f) => f.key)]);
        const custom = Object.entries(tags).filter(([k, v]) => !preset.has(k) && v);
        if (custom.length) {
            const chips = el('div', 'lf-chips');
            for (const [k, v] of custom) {
                const c = el('span', 'lf-chip on lf-chip-kv', `${k}: ${v}`);
                if (!ro) {
                    const x = el('button', 'lf-x', '×');
                    x.type = 'button';
                    x.title = `Remove ${k}`;
                    x.onclick = () => setTag(k, '');
                    c.append(x);
                }
                chips.append(c);
            }
            s.append(this.row('Custom', chips));
        }
        return s;
    }

    private addCustomTag(s: HTMLElement) {
        const r = el('div', 'lf-row');
        const k = el('input', 'lf-inp lf-in');
        k.placeholder = 'key';
        const v = el('input', 'lf-inp lf-in');
        v.placeholder = 'value';
        const ok = () => {
            const key = k.value.trim(), val = v.value.trim();
            if (key && val) this.o.change({ tags: { ...(this.label.tags || {}), [key]: val } });
        };
        v.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
        const wrap = el('div', 'lf-val lf-kv');
        wrap.append(k, v);
        r.append(el('span', 'lf-name', 'New tag'), wrap);
        s.append(r);
        k.focus();
    }

    // ── XENO-CANTO ANNOTA ──
    private sectionAnnota(l: any, ro: boolean) {
        const tags: Record<string, string> = { ...(l.tags || {}) };
        const hidden = ANNOTA_FIELDS.filter((f) => f.kind !== 'yn' && f.key !== 'remarks');
        const open = !this.collapsed.has('annota-more');
        const more = el('button', 'lf-link', open ? 'fewer ▴' : `${hidden.length} more ▸`);
        more.type = 'button';
        more.onclick = () => { if (open) this.collapsed.add('annota-more'); else this.collapsed.delete('annota-more'); this.render(this.label); };
        const s = this.section('annota', 'Xeno-canto Annota', more);
        const setTag = (k: string, v: string) => this.setTag(k, v);
        const text = (key: string, multi: boolean, type = 'text') => {
            const i = multi ? el('textarea', 'lf-inp lf-ta') : el('input', 'lf-inp lf-in');
            if (i instanceof HTMLInputElement) i.type = type;
            i.value = String(tags[key] ?? '');
            i.disabled = ro;
            i.onchange = () => setTag(key, i.value.trim());
            return i;
        };
        s.append(this.row('Remarks', text('remarks', true)));
        // the y/n fields in one row: "Seen y n  Playback y n  Overlap y n"
        const yn = el('div', 'lf-yn');
        ANNOTA_FIELDS.filter((f) => f.kind === 'yn').forEach((f, i) => {
            // name and buttons stay together when the row wraps (narrow Properties panel)
            const pair = el('span', 'lf-yn-pair');
            if (i) pair.append(el('span', 'lf-yn-name', f.short));
            yn.append(pair);
            pair.append(seg([{ value: 'y', text: 'y' }, { value: 'n', text: 'n' }], toYN(tags[f.key]),
                (v) => setTag(f.key, toYN(tags[f.key]) === v ? '' : v), ro));
        });
        const ynFirst = ANNOTA_FIELDS.find((f) => f.kind === 'yn');
        s.append(this.row(ynFirst?.short || 'Seen', yn));
        if (open) for (const f of hidden) s.append(this.row(f.short, text(f.key, false, f.kind === 'date' ? 'date' : 'text')));
        return s;
    }

    // ── BOX ──
    private sectionBox(l: any, ro: boolean) {
        const timeOnly = l.fullBand === true || l.freqMin == null || l.freqMax == null;
        const mode = seg([{ value: 'box', text: 'Box' }, { value: 'time', text: 'Time only' }], timeOnly ? 'time' : 'box',
            (v) => this.o.change(v === 'time' ? { fullBand: true } : { fullBand: false }), ro);
        const s = this.section('box', 'Box', mode);
        const num = (val: number, side: string, unit: 's' | 'kHz', key: string, extra = '') => {
            const box = el('label', 'lf-inp lf-num');
            const i = el('input');
            i.disabled = ro;
            const show = () => (unit === 's' ? (this.o.clock ? this.o.clock(val) : val.toFixed(2)) : `${(val / 1000).toFixed(2)} kHz`);
            i.value = show();
            i.onchange = () => {
                const raw = i.value.trim();
                let v: number;
                if (unit === 'kHz') v = parseFloat(raw.replace(',', '.')) * 1000;
                else v = parseClock(raw, val, this.o.clock);
                if (!Number.isFinite(v)) { i.value = show(); return; }
                this.o.change({ [key]: v });
            };
            box.append(i, el('span', 'lf-side', side + extra));
            return box;
        };
        const g1 = el('div', 'lf-geo');
        g1.append(num(l.start, 'start', 's', 'start'), num(l.end, 'end', 's', 'end', ` · ${(l.end - l.start).toFixed(2)} s`));
        s.append(g1);
        if (!timeOnly) {
            const g2 = el('div', 'lf-geo');
            g2.append(num(l.freqMin, 'low', 'kHz', 'freqMin'), num(l.freqMax, 'high', 'kHz', 'freqMax'));
            s.append(g2);
        }
        if (this.o.channels > 1) {
            const ch = l.channel == null ? 'mix' : String(l.channel);
            s.append(this.row('Channel', seg([{ value: '0', text: 'L' }, { value: '1', text: 'R' }, { value: 'mix', text: 'Mix' }], ch,
                (v) => this.o.change({ channel: v === 'mix' ? undefined : Number(v) }), ro)));
        }
        return s;
    }

    // ── SOURCE ──
    private sectionSource(l: any) {
        const s = this.section('source', 'Source');
        const src = this.o.source(l);
        const p = el('div', 'lf-src');
        const a = el('div');
        a.append(el('span', 'lf-m', 'From '), src.from);
        const b = el('div');
        b.append(el('span', 'lf-m', 'Author '), src.author);
        if (src.history && this.o.showHistory) {
            const h = el('button', 'lf-link', `History (${src.history})`);
            h.type = 'button';
            h.onclick = () => this.o.showHistory!();
            b.append(' · ', h);
        }
        p.append(a, b);
        const snr = this.o.snr ? this.o.snr(l) : (Number.isFinite(l.snr) ? `${Number(l.snr).toFixed(1)} dB` : '');
        if (snr) {
            const c = el('div');
            c.append(el('span', 'lf-m', 'SNR '), snr);
            p.append(c);
        }
        s.append(p);
        return s;
    }
}

/** "21:31:12.40" / "12.4" → seconds in the recording (clock times relative to the current value). */
export function parseClock(raw: string, current: number, clock?: ((s: number) => string) | null): number {
    const t = raw.trim().replace(',', '.');
    if (/^-?\d+(\.\d+)?$/.test(t)) {
        // a plain number is seconds into the recording (no clock) or seconds of the minute (clock)
        if (!clock) return parseFloat(t);
    }
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(t);
    if (!m || !clock) return clock ? NaN : parseFloat(t);
    const sec = (h: number, mi: number, s: number) => h * 3600 + mi * 60 + s;
    const want = m[3] != null ? sec(+m[1], +m[2], parseFloat(m[3])) : sec(0, +m[1], parseFloat(m[2]));
    const cm = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(clock(current));
    if (!cm) return NaN;
    const have = sec(+cm[1], +cm[2], parseFloat(cm[3]));
    let d = want - have;
    if (m[3] == null) d = want - (have % 3600);   // "mm:ss" within the hour
    if (d > 43200) d -= 86400; else if (d < -43200) d += 86400;
    return current + d;
}
