/**
 * Upload selection panel — "What goes into the set" + "Uploaded sets" in the Upload tab.
 * Pure view: the host passes candidates / selection / snapshots (app/upload-selection.ts)
 * and gets the changed selection back via onChange.
 */

import type { UploadCandidates, UploadSelection, UploadSnapshot, SnapshotState } from '../../app/upload-selection.ts';

export interface SnapshotRow { snap: UploadSnapshot; state: SnapshotState; missing: number }

export interface UploadSelectionPanelOptions {
    el: HTMLElement;
    uploadsEl: HTMLElement;
    onChange: (sel: UploadSelection) => void;
    onForgetSnapshot?: (id: string) => void;
    onAssignXc?: (recordingId: string) => void;
    layerName?: (id: string) => string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class UploadSelectionPanel {
    o: UploadSelectionPanelOptions;
    constructor(opts: UploadSelectionPanelOptions) { this.o = opts; }

    render(cand: UploadCandidates, sel: UploadSelection, snapshots: SnapshotRow[]) {
        this._renderSelection(cand, sel);
        this._renderSnapshots(snapshots);
    }

    _group(title: string, hint = '') {
        const g = document.createElement('fieldset');
        g.className = 'us-group';
        const lg = document.createElement('legend');
        lg.textContent = title;
        g.appendChild(lg);
        if (hint) {
            const p = document.createElement('p');
            p.className = 'field-hint';
            p.textContent = hint;
            g.appendChild(p);
        }
        return g;
    }

    _check(label: string, count: string, checked: boolean, onToggle: (on: boolean) => void, disabled = false, note = '') {
        const row = document.createElement('label');
        row.className = 'us-row' + (disabled ? ' us-row--disabled' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked && !disabled;
        cb.disabled = disabled;
        cb.addEventListener('change', () => onToggle(cb.checked));
        const name = document.createElement('span');
        name.className = 'us-name';
        name.textContent = label;
        row.append(cb, name);
        if (note) {
            const n = document.createElement('span');
            n.className = 'us-note';
            n.textContent = note;
            row.appendChild(n);
        }
        const c = document.createElement('span');
        c.className = 'us-count';
        c.textContent = count;
        row.appendChild(c);
        return row;
    }

    _renderSelection(cand: UploadCandidates, sel: UploadSelection) {
        const el = this.o.el;
        el.innerHTML = '';
        const change = (patch: Partial<UploadSelection>) => this.o.onChange({ ...sel, ...patch });
        const toggleIn = (list: string[], key: string, on: boolean) =>
            (on ? list.filter((x) => x !== key) : [...new Set([...list, key])]);

        if (!cand.recordings.length) {
            const p = document.createElement('p');
            p.className = 'field-hint';
            p.textContent = 'No own labels yet. Draw labels on a recording — they can then go into an XC set.';
            el.appendChild(p);
            return;
        }

        // Recordings
        const recs = this._group('Recordings', 'Only recordings with an XC number can be part of an XC set.');
        for (const r of cand.recordings) {
            const n = (sel.sources.includes('own') ? r.own : 0) + (sel.sources.includes('birdnet') ? r.birdnet : 0);
            const row = this._check(r.xcId ? `${r.xcId}` : r.name, String(n), r.included,
                (on) => change({ excludedRecordings: toggleIn(sel.excludedRecordings, r.id, on) }),
                !r.xcId, r.xcId ? (r.name !== `${r.xcId}.mp3` ? r.name : '') : 'local only');
            if (!r.xcId && this.o.onAssignXc) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'ua-jump';
                b.textContent = 'Assign XC number…';
                b.addEventListener('click', (e) => { e.preventDefault(); this.o.onAssignXc!(r.id); });
                row.appendChild(b);
            }
            recs.appendChild(row);
        }
        el.appendChild(recs);

        // Species
        if (cand.species.size) {
            const sp = this._group('Species');
            for (const [key, n] of [...cand.species].sort((a, b) => a[0].localeCompare(b[0]))) {
                sp.appendChild(this._check(key, String(n), !sel.excludedSpecies.includes(key),
                    (on) => change({ excludedSpecies: toggleIn(sel.excludedSpecies, key, on) })));
            }
            el.appendChild(sp);
        }

        // Layers — only when there is more than the default layer
        if (cand.layers.size > 1 || [...cand.layers.keys()].some((k) => k !== 'default')) {
            const ly = this._group('Layers');
            for (const [id, n] of cand.layers) {
                ly.appendChild(this._check(this.o.layerName?.(id) || id, String(n), !sel.excludedLayers.includes(id),
                    (on) => change({ excludedLayers: toggleIn(sel.excludedLayers, id, on) })));
            }
            el.appendChild(ly);
        }

        // Sources
        const birdnet = cand.recordings.reduce((s, r) => s + r.birdnet, 0);
        const src = this._group('Sources');
        src.appendChild(this._check('Own labels', '', true, () => {}, false));
        (src.lastChild as HTMLElement).querySelector('input')!.disabled = true;
        src.appendChild(this._check('BirdNET detections', String(birdnet), sel.sources.includes('birdnet'),
            (on) => change({ sources: on ? ['own', 'birdnet'] : ['own'] }), !birdnet));
        el.appendChild(src);
    }

    _renderSnapshots(rows: SnapshotRow[]) {
        const el = this.o.uploadsEl;
        el.innerHTML = '';
        el.hidden = !rows.length;
        if (!rows.length) return;
        const h = document.createElement('div');
        h.className = 'sidebar-section-header';
        h.textContent = 'Uploaded sets';
        el.appendChild(h);
        for (const { snap, state, missing } of [...rows].sort((a, b) => b.snap.uploadedAt.localeCompare(a.snap.uploadedAt))) {
            const row = document.createElement('div');
            row.className = `us-snap us-snap--${state}`;
            const title = document.createElement('div');
            title.className = 'us-snap-title';
            title.textContent = snap.name || 'Unnamed set';
            const badge = document.createElement('span');
            badge.className = 'us-snap-badge';
            badge.textContent = state === 'current' ? 'up to date' : 'changed';
            title.appendChild(badge);
            const meta = document.createElement('div');
            meta.className = 'us-snap-meta';
            meta.textContent = [
                new Date(snap.uploadedAt).toLocaleString(), snap.env !== 'live' ? snap.env.toUpperCase() : '',
                plural(snap.labelIds.length, 'label'), snap.recordings.join(', '),
            ].filter(Boolean).join(' · ');
            row.append(title, meta);
            if (state === 'changed') {
                const p = document.createElement('p');
                p.className = 'field-hint';
                p.textContent = (missing ? `${plural(missing, 'label')} deleted, others edited or kept. ` : 'Labels were edited since the upload. ')
                    + 'XC sets cannot be edited: delete the set on xeno-canto.org and upload again.';
                row.appendChild(p);
            }
            if (this.o.onForgetSnapshot) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'ua-jump';
                b.textContent = 'Forget';
                b.title = 'Remove this entry (does not touch the set on Xeno-canto)';
                b.addEventListener('click', () => this.o.onForgetSnapshot!(snap.id));
                row.appendChild(b);
            }
            el.appendChild(row);
        }
    }
}
