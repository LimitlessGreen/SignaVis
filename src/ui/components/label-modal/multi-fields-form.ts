// multi-fields-form.ts — fields of several labels at once (Annotate v2 mockup M3, right side)
//
// Only fields that apply to all: LABEL (species, presence) · TAGS · XENO-CANTO ANNOTA. Equal values show
// normally ("all 3"), different ones as "mixed" (hatched) with counts per value. A click sets the value on
// all; changed fields are marked "changed". Only what is changed is written (per label, other tags kept).
// BOX is left out on purpose; SOURCE is a one-line summary.

import { ANNOTA_FIELDS, toYN } from '../../../domain/labelFields.ts';
import { colorForName } from '../../../domain/annotations.ts';
import type { FieldsFormOptions, TagPreset } from './label-fields-form.ts';

/** One edit for all labels: a label field or one tag ('' removes the tag). */
export type MultiEdit = { set: Record<string, any> } | { tag: string; value: string };

/** How often each value occurs ('' = not set), most frequent first. */
export function tally(labels: any[], get: (l: any) => unknown): [string, number][] {
    const m = new Map<string, number>();
    for (const l of labels) { const v = String(get(l) ?? ''); m.set(v, (m.get(v) || 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The updates one label gets for an edit (tags merged into its own). */
export function updatesFor(l: any, e: MultiEdit): Record<string, any> {
    if ('set' in e) {
        // colour follows the species unless the label has its own (custom…)
        if (e.set.label && !l.colorCustom) return { ...e.set, color: colorForName(e.set.label) };
        return { ...e.set };
    }
    const tags = { ...(l.tags || {}) };
    if (e.value) tags[e.tag] = e.value; else delete tags[e.tag];
    return { tags };
}

export interface MultiFormOptions {
    edit: (e: MultiEdit) => void;
    speciesSearch?: FieldsFormOptions['speciesSearch'];
    tagPresets: TagPreset[];
    /** "2 from BirdNET, 1 drawn" */
    sourceSummary: (labels: any[]) => string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};

export class MultiFieldsForm {
    readonly el = el('div', 'lf-form lf-multi');
    /** Keys changed since the selection was opened ("label", "polarity", "tag:soundType" …). */
    readonly changed = new Set<string>();
    private labels: any[] = [];
    private widgets: { destroy?: () => void }[] = [];

    constructor(private o: MultiFormOptions) {}

    destroy() { for (const w of this.widgets) w.destroy?.(); this.widgets = []; }

    render(labels: any[]) {
        this.labels = labels;
        this.destroy();
        this.el.replaceChildren();
        if (!labels.length) return;
        this.el.append(this.sLabel(), this.sTags(), this.sAnnota(), this.folded('Box', 'not for several labels'),
            this.folded('Source', this.o.sourceSummary(labels)));
    }

    private go(e: MultiEdit) {
        this.changed.add('set' in e ? Object.keys(e.set)[0] : `tag:${e.tag}`);
        this.o.edit(e);
    }

    private sec(title: string) {
        const s = el('section', 'lf-sec');
        const h = el('h4', 'lf-h');
        h.append(el('span', 'lf-car', '▾'), el('span', '', title));
        s.append(h);
        return s;
    }
    private folded(title: string, note: string) {
        const s = el('section', 'lf-sec collapsed');
        const h = el('h4', 'lf-h');
        h.append(el('span', 'lf-car', '▸'), el('span', '', title), el('span', 'lf-h-r lf-note', note));
        s.append(h);
        return s;
    }
    private row(name: string, ...c: (Node | string)[]) {
        const r = el('div', 'lf-row');
        const v = el('div', 'lf-val');
        v.append(...c);
        r.append(el('span', 'lf-name', name), v);
        return r;
    }
    private mark(key: string) { return this.changed.has(key) ? el('span', 'lf-chg', 'changed') : ''; }
    private cnt(n: number) { return el('b', 'lf-cnt', n === this.labels.length ? `all ${n}` : String(n)); }

    /** Segmented buttons; when values differ a hatched "mixed: a 2, – 1" button comes first. */
    private seg(key: string, options: { value: string; text: string; tone?: 'ok' | 'no' }[], counts: [string, number][], pick: (v: string) => void) {
        const s = el('span', 'lf-seg');
        const mixed = counts.length > 1;
        if (mixed) {
            const txt = 'mixed: ' + counts.map(([v, n]) => `${v || '–'} ${n}`).join(', ');
            const m = el('span', 'lf-seg-b lf-mixed', txt);
            s.append(m);
        }
        const one = mixed ? null : counts[0]?.[0] ?? '';
        for (const o of options) {
            const on = one !== null && o.value === one;
            const b = el('button', 'lf-seg-b' + (on ? ' on' : '') + (o.tone && on ? ` ${o.tone}` : ''), o.text);
            b.type = 'button';
            b.onclick = () => pick(o.value);
            s.append(b);
        }
        const w = el('span', 'lf-segw');
        w.append(s, this.mark(key));
        return w;
    }

    private sLabel() {
        const s = this.sec('Label');
        const names = tally(this.labels, (l) => l.label);
        const sp = el('div', 'lf-inp lf-species');
        const sw = el('span', 'lf-sw');
        sw.style.background = names.length === 1 ? colorForName(names[0][0]) : 'transparent';
        if (this.o.speciesSearch) {
            const w = this.o.speciesSearch(({ name, scientificName }) => {
                this.go({ set: { label: name, scientificName: scientificName || '', commonName: '' } });
            });
            this.widgets.push(w);
            w.input.value = names.length === 1 ? names[0][0] : '';
            w.input.placeholder = names.length > 1 ? `mixed (${names.length} species) – picking sets all` : '';
            sp.append(sw, w.el);
        } else sp.append(sw, el('span', '', names.length === 1 ? names[0][0] : `mixed (${names.length})`));
        if (names.length === 1) sp.append(this.cnt(names[0][1]));
        sp.append(this.mark('label'));
        s.append(this.row('Species', sp));
        s.append(this.row('Presence', this.seg('polarity', [
            { value: 'present', text: 'Present', tone: 'ok' }, { value: 'absent', text: 'Absent', tone: 'no' },
        ], tally(this.labels, (l) => (l.polarity === 'absent' ? 'absent' : 'present')),
        (v) => this.go({ set: { polarity: v === 'absent' ? 'absent' : undefined } }))));
        return s;
    }

    private sTags() {
        const s = this.sec('Tags');
        const presets = [...this.o.tagPresets].sort((a, b) => Number(b.key === 'soundType') - Number(a.key === 'soundType'));
        const nice = (p: TagPreset) => (p.label && p.label !== p.key ? p.label
            : p.key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c) => ` ${c.toLowerCase()}`));
        for (const p of presets) {
            const counts = tally(this.labels, (l) => l.tags?.[p.key]);
            const set = (v: string) => this.go({ tag: p.key, value: v });
            if (p.key === 'soundType') {
                const chips = el('div', 'lf-chips');
                const n = new Map(counts);
                const vals = [...new Set([...p.options.slice(0, 5), ...counts.map(([v]) => v).filter(Boolean)])];
                for (const v of vals) {
                    const k = n.get(v) || 0;
                    const all = k === this.labels.length;
                    const c = el('button', 'lf-chip' + (all ? ' on' : ''), v);
                    c.type = 'button';
                    if (k) c.append(' ', this.cnt(k));
                    c.onclick = () => set(all ? '' : v);
                    chips.append(c);
                }
                chips.append(this.mark('tag:soundType'));
                s.append(this.row(nice(p), chips));
            } else {
                const opts = p.options.slice(0, 3).map((v) => ({ value: v, text: v }));
                for (const [v] of counts) if (v && !opts.some((o) => o.value === v)) opts.push({ value: v, text: v });
                opts.push({ value: '', text: '–' });
                s.append(this.row(nice(p), this.seg(`tag:${p.key}`, opts, counts, set)));
            }
        }
        // own tags: "quality: A 1 of 3"; a click sets it on all, × removes it from all
        const known = new Set([...this.o.tagPresets.map((p) => p.key), ...ANNOTA_FIELDS.map((f) => f.key)]);
        const custom = new Map<string, number>();
        for (const l of this.labels) for (const [k, v] of Object.entries(l.tags || {})) if (!known.has(k) && v) custom.set(`${k}\u0000${v}`, (custom.get(`${k}\u0000${v}`) || 0) + 1);
        const chips = el('div', 'lf-chips');
        for (const [kv, n] of custom) {
            const [k, v] = kv.split('\u0000');
            const c = el('span', 'lf-chip on lf-chip-kv', `${k}: ${v} `);
            c.append(el('b', 'lf-cnt', n === this.labels.length ? `all ${n}` : `${n} of ${this.labels.length}`));
            if (n < this.labels.length) {
                const a = el('button', 'lf-x', '+');
                a.type = 'button'; a.title = `Set ${k}: ${v} on all`;
                a.onclick = () => this.go({ tag: k, value: v });
                c.append(a);
            }
            const x = el('button', 'lf-x', '×');
            x.type = 'button'; x.title = `Remove ${k} from all`;
            x.onclick = () => this.go({ tag: k, value: '' });
            c.append(x);
            chips.append(c);
        }
        const add = el('button', 'lf-chip lf-chip-add', '+ tag for all');
        add.type = 'button';
        add.onclick = () => {
            const r = el('span', 'lf-kv');
            const k = el('input', 'lf-inp lf-in'); k.placeholder = 'key';
            const v = el('input', 'lf-inp lf-in'); v.placeholder = 'value';
            v.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (k.value.trim() && v.value.trim()) this.go({ tag: k.value.trim(), value: v.value.trim() }); } };
            r.append(k, v);
            add.replaceWith(r);
            k.focus();
        };
        chips.append(add);
        s.append(this.row('Custom', chips));
        return s;
    }

    private sAnnota() {
        const s = this.sec('Xeno-canto Annota');
        const rem = tally(this.labels, (l) => l.tags?.remarks);
        const ta = el('textarea', 'lf-inp lf-ta');
        if (rem.length === 1) ta.value = rem[0][0];
        else {
            const has = this.labels.filter((l) => l.tags?.remarks).length;
            ta.placeholder = `mixed (${has} of ${this.labels.length} have remarks) – typing replaces all`;
            ta.classList.add('lf-mixed');
        }
        ta.onchange = () => this.go({ tag: 'remarks', value: ta.value.trim() });
        const w = el('span', 'lf-segw lf-grow');
        w.append(ta, this.mark('tag:remarks'));
        s.append(this.row('Remarks', w));
        for (const f of ANNOTA_FIELDS.filter((x) => x.kind === 'yn')) {
            s.append(this.row(f.short, this.seg(`tag:${f.key}`, [{ value: 'y', text: 'y' }, { value: 'n', text: 'n' }, { value: '', text: '–' }],
                tally(this.labels, (l) => toYN(l.tags?.[f.key])), (v) => this.go({ tag: f.key, value: v }))));
        }
        return s;
    }
}
