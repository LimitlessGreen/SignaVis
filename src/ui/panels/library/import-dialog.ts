// ═══════════════════════════════════════════════════════════════════════
// ui/panels/library/import-dialog.ts — import a folder into the catalog
//
// Source folder → import profile (path templates + field roles + clock) →
// live preview (nothing written) → referenced import. The profile is saved
// in the catalog and can be picked again for the next folder.
// ═══════════════════════════════════════════════════════════════════════

import {
    emptyProfile, formatBytes, syncMappings,
    type FieldRole, type ImportResult, type Preview, type ProfileSpec,
} from '../../../domain/catalog/catalog-types.ts';
import { catalogApi, pickFolder } from '../../../infrastructure/tauri/catalogApi.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const ROLES: { value: string; label: string }[] = [
    { value: 'site', label: 'Site' },
    { value: 'device', label: 'Recorder' },
    { value: 'start', label: 'Start (date + time)' },
    { value: 'date', label: 'Start date' },
    { value: 'time', label: 'Start time' },
    { value: 'meta', label: 'Metadata' },
    { value: 'ignore', label: 'Ignore' },
];

const ISSUE_TEXT: Record<string, string> = {
    'no-start': 'no start time',
    'implausible-time': 'implausible start time (before 2000 or in the future)',
    'duplicate-time': 'same recorder and start time twice (duplicate files?)',
};

export interface ImportDialogOptions {
    projectRoot: string;
    onImported: (r: ImportResult) => void;
}

export class ImportDialog {
    el: HTMLElement;
    #o: ImportDialogOptions;
    #source = '';
    #rootName = '';
    #profile: ProfileSpec = { ...emptyProfile('profile'), utcOffsetMin: -new Date().getTimezoneOffset() };
    #saved: ProfileSpec[] = [];
    #preview: Preview | null = null;
    #status = '';
    #busy = false;
    #importTables = true;
    #timer: ReturnType<typeof setTimeout> | null = null;

    constructor(o: ImportDialogOptions) {
        this.#o = o;
        this.el = document.createElement('div');
        this.el.className = 'lib-import';
        this.el.addEventListener('click', (e) => this.#onClick(e));
        this.el.addEventListener('input', (e) => this.#onInput(e));
        this.el.addEventListener('change', (e) => this.#onInput(e));
        void catalogApi.profiles(o.projectRoot).then((p) => {
            this.#saved = p;
            if (p[0]) this.#profile = structuredClone(p[0]);
            this.#render();
        }).catch(() => {});
        this.#render();
    }

    #schedulePreview(refresh = false) {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => void this.#runPreview(refresh), 350);
    }

    async #runPreview(refresh: boolean) {
        if (!this.#source || !this.#profile.patterns.length) { this.#preview = null; this.#renderPreviewArea(); return; }
        this.#status = refresh ? 'Scanning folder…' : 'Checking…';
        this.#renderStatus();
        try {
            this.#preview = await catalogApi.preview(this.#source, this.#profile, refresh);
            this.#status = '';
        } catch (e) {
            this.#preview = null;
            this.#status = `Error: ${e}`;
        }
        this.#renderPreviewArea();
    }

    async #onClick(e: Event) {
        const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!t || this.#busy) return;
        e.stopPropagation();   // actions of the dialog are not the library's
        const act = t.dataset.act;
        if (act === 'pick') {
            const p = await pickFolder('Folder to import');
            if (!p) return;
            this.#source = p;
            this.#rootName = p.split(/[\\/]/).filter(Boolean).pop() || 'source';
            this.#render();
            await this.#runPreview(true);
        } else if (act === 'rescan') {
            await this.#runPreview(true);
        } else if (act === 'run-import') {
            await this.#import();
        } else if (act === 'add-pattern') {
            const ex = this.#preview?.unmatchedGroups[0]?.example;
            this.#profile.patterns.push(ex ? ex.replace(/[^/]+$/, '{file}.wav') : '');
            this.#render();
        }
    }

    #onInput(e: Event) {
        const t = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const p = this.#profile;
        switch (t.dataset.k) {
            case 'patterns': {
                const patterns = (t as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean);
                if (patterns.join('\n') === p.patterns.join('\n')) return;   // e.g. the change event on blur
                p.patterns = patterns;
                const before = p.mappings.map((m) => m.field).join();
                p.mappings = syncMappings(p.patterns, p.mappings);
                // Rebuild the role table only when the fields changed (keeps focus and typed values).
                if (p.mappings.map((m) => m.field).join() !== before) this.#renderMappings();
                this.#schedulePreview();
                return;
            }
            case 'role': {
                const m = p.mappings[Number(t.dataset.i)];
                m.role = (t.value === 'meta' ? `meta:${m.field}` : t.value) as FieldRole;
                this.#renderMappings();
                break;
            }
            case 'metaKey': {
                const m = p.mappings[Number(t.dataset.i)];
                m.role = `meta:${t.value.trim() || m.field}`;
                break;
            }
            case 'format': {
                const m = p.mappings[Number(t.dataset.i)];
                m.format = t.value.includes('{}') ? t.value : undefined;
                break;
            }
            case 'offset': p.utcOffsetMin = Number(t.value) || 0; break;
            case 'derived': p.derivedDirs = t.value.split(',').map((s) => s.trim()).filter(Boolean); this.#schedulePreview(true); return;
            case 'name': p.name = t.value.trim() || 'profile'; return;
            case 'rootName': this.#rootName = t.value.trim(); return;
            case 'tables': this.#importTables = (t as HTMLInputElement).checked; return;
            case 'saved': {
                const s = this.#saved.find((x) => x.name === t.value);
                if (s) { this.#profile = structuredClone(s); this.#render(); }
                break;
            }
            default: return;
        }
        this.#schedulePreview();
    }

    async #import() {
        if (!this.#source || !this.#rootName) return;
        this.#busy = true;
        this.#status = 'Importing…';
        this.#renderPreviewArea();
        try {
            const r = await catalogApi.import(this.#o.projectRoot, this.#source, this.#rootName, this.#profile, this.#importTables);
            this.#status = `Imported ${r.inserted.toLocaleString()} recordings`
                + (r.alreadyKnown ? `, ${r.alreadyKnown.toLocaleString()} already known` : '')
                + (r.moved ? `, ${r.moved.toLocaleString()} renamed or moved (labels kept)` : '')
                + (r.missing ? `, ${r.missing.toLocaleString()} no longer found` : '')
                + (r.changed ? `, ${r.changed.toLocaleString()} changed` : '')
                + (r.unmatched ? `, ${r.unmatched} without pattern match` : '')
                + (r.detections ? `, ${r.detections.toLocaleString()} BirdNET detections from ${r.tables} tables` : '') + '.';
            this.#o.onImported(r);
        } catch (e) {
            this.#status = `Import failed: ${e}`;
        } finally {
            this.#busy = false;
            this.#renderPreviewArea();
        }
    }

    /** Preview, status and the import button; leaves the form (and its focus) alone. */
    #renderPreviewArea() {
        const pv = this.el.querySelector('.lib-import-preview');
        if (pv) pv.innerHTML = this.#renderPreview();
        const btn = this.el.querySelector<HTMLButtonElement>('[data-act="run-import"]');
        if (btn) btn.disabled = !(this.#source && this.#rootName && this.#preview && !this.#busy);
        this.#renderStatus();
    }

    #renderStatus() {
        const s = this.el.querySelector('.lib-import-status');
        if (s) s.textContent = this.#status;
    }

    #renderMappings() {
        const host = this.el.querySelector('.lib-map');
        if (!host) return;
        const rows = this.#profile.mappings.map((m, i) => {
            const isMeta = m.role.startsWith('meta:');
            const sel = isMeta ? 'meta' : m.role;
            const named = m.role === 'site' || m.role === 'device';
            return `<tr><td><code>{${esc(m.field)}}</code></td>
              <td><select class="field-select" data-k="role" data-i="${i}">${ROLES.map((r) =>
                `<option value="${r.value}"${r.value === sel ? ' selected' : ''}>${r.label}</option>`).join('')}</select></td>
              <td>${isMeta ? `<input class="input" data-k="metaKey" data-i="${i}" value="${esc(m.role.slice(5))}" title="Metadata key">`
                : named ? `<input class="input" data-k="format" data-i="${i}" value="${esc(m.format ?? '')}" placeholder="e.g. Site {}" title="Display name, {} = value">` : ''}</td></tr>`;
        }).join('');
        host.innerHTML = rows ? `<table class="lib-table lib-table--compact"><thead><tr><th>Field</th><th>Meaning</th><th>Name / key</th></tr></thead><tbody>${rows}</tbody></table>`
            : '<p class="lib-hint">Fields appear here when the patterns contain <code>{name}</code>.</p>';
    }

    #renderPreview(): string {
        const pv = this.#preview;
        if (!pv) return this.#source ? '<p class="lib-hint">Enter a pattern to see what it recognises.</p>' : '';
        const matched = pv.perPattern.reduce((a, b) => a + b, 0);
        // Never round up to 100 % while files are missing.
        const pct = pv.audioFiles ? Math.min(Math.round((matched / pv.audioFiles) * 1000) / 10, matched < pv.audioFiles ? 99.9 : 100) : 0;
        const issues = pv.issues.map((i) => `<li class="lib-issue"><b>${i.count.toLocaleString()}</b> × ${esc(ISSUE_TEXT[i.kind] || i.kind)}
            <div class="lib-examples">${i.examples.map((x) => `<code>${esc(x)}</code>`).join('')}</div></li>`).join('');
        const unmatched = pv.unmatchedGroups.slice(0, 20).map((g) =>
            `<tr><td><code>${esc(g.dir || '.')}</code></td><td class="num">${g.count.toLocaleString()}</td><td><code>${esc(g.example)}</code></td></tr>`).join('');
        const groups = pv.groups.map((g) => `<tr><td>${esc(g.site ?? '—')}</td><td>${esc(g.device ?? '—')}</td>
            <td class="num">${g.files.toLocaleString()}</td><td class="num">${formatBytes(g.bytes)}</td>
            <td>${esc(g.first?.replace('T', ' ') ?? '—')}</td><td>${esc(g.last?.replace('T', ' ') ?? '—')}</td></tr>`).join('');
        const samples = pv.samples.slice(0, 40).map((s) => `<tr class="${s.pattern == null ? 'is-unmatched' : ''}">
            <td><code>${esc(s.path)}</code></td><td>${esc(s.site ?? '')}</td><td>${esc(s.device ?? '')}</td>
            <td>${esc(s.start?.replace('T', ' ') ?? '')}</td><td>${esc(s.meta.map(([k, v]) => `${k}=${v}`).join(', '))}</td></tr>`).join('');
        return `
          <div class="lib-summary">
            <span><b>${pv.audioFiles.toLocaleString()}</b> audio files (${formatBytes(pv.audioBytes)})</span>
            <span class="${pct < 100 ? 'is-warn' : 'is-ok'}"><b>${pct}%</b> recognised${pv.perPattern.length > 1 ? ` (${pv.perPattern.map((n, i) => `pattern ${i + 1}: ${n.toLocaleString()}`).join(', ')})` : ''}</span>
            ${pv.selectionTables ? `<span>${pv.selectionTables.toLocaleString()} BirdNET/Raven tables</span>` : ''}
            ${pv.skippedDirs.length ? `<span title="${esc(pv.skippedDirs.join('\n'))}">${pv.skippedDirs.length} derived folders skipped</span>` : ''}
          </div>
          ${issues ? `<h4>Check</h4><ul class="lib-issues">${issues}</ul>` : ''}
          ${unmatched ? `<h4>Not recognised <button class="btn btn--sm btn--ghost" data-act="add-pattern" title="Add a pattern line from the first example">+ pattern</button></h4>
            <table class="lib-table lib-table--compact"><thead><tr><th>Folder</th><th class="num">Files</th><th>Example</th></tr></thead><tbody>${unmatched}</tbody></table>` : ''}
          ${groups ? `<h4>Sites and recorders</h4><table class="lib-table lib-table--compact"><thead><tr><th>Site</th><th>Recorder</th><th class="num">Files</th><th class="num">Size</th><th>First</th><th>Last</th></tr></thead><tbody>${groups}</tbody></table>` : ''}
          <h4>Examples</h4>
          <table class="lib-table lib-table--compact"><thead><tr><th>Path</th><th>Site</th><th>Recorder</th><th>Start (local)</th><th>Metadata</th></tr></thead><tbody>${samples}</tbody></table>`;
    }

    #render() {
        const p = this.#profile;
        const canImport = !!(this.#source && this.#rootName && this.#preview && !this.#busy);
        this.el.innerHTML = `
          <div class="lib-import-form">
            <label class="lib-field"><span>Folder</span>
              <span class="lib-row"><input class="input" readonly value="${esc(this.#source)}" placeholder="Choose a folder…">
              <button class="btn btn--sm" data-act="pick">Choose…</button>
              ${this.#source ? '<button class="btn btn--sm btn--ghost" data-act="rescan" title="Scan the folder again">Rescan</button>' : ''}</span></label>
            <label class="lib-field"><span>Source name</span><input class="input" data-k="rootName" value="${esc(this.#rootName)}"
              title="Name of this source in the project. If the folder moves (other drive, other computer), only its location changes."></label>
            <p class="lib-hint">The files stay where they are; the project only references them.</p>
            ${this.#saved.length ? `<label class="lib-field"><span>Saved profile</span><select class="field-select" data-k="saved">
              ${this.#saved.map((s) => `<option${s.name === p.name ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
            <label class="lib-field"><span>Profile name</span><input class="input" data-k="name" value="${esc(p.name)}"></label>
            <label class="lib-field lib-field--wide"><span>Path patterns (one per line, first match wins)</span>
              <textarea class="input lib-patterns" data-k="patterns" rows="3" spellcheck="false"
                placeholder="{site}/{recorder}_{start:%Y%m%d_%H%M%S}.wav">${esc(p.patterns.join('\n'))}</textarea></label>
            <details class="lib-help"><summary>Pattern syntax</summary>
              <ul>
                <li><code>{name}</code> any text within one folder or file name; the name is yours to choose</li>
                <li><code>{name:int}</code> digits</li>
                <li><code>{name:%Y_%m_%d_%H_%M_%S}</code> date/time (%Y %m %d %H %M %S %y %j)</li>
                <li><code>{*}</code> any text, not kept · <code>*</code> anything within one name · <code>**/</code> any number of folders</li>
                <li>A field used twice (folder and file name) must have the same value.</li>
              </ul></details>
            <div class="lib-field lib-field--wide"><span>What the fields mean</span><div class="lib-map"></div></div>
            <label class="lib-field"><span>Recorder clock (minutes ahead of UTC)</span>
              <input class="input" type="number" step="15" data-k="offset" value="${p.utcOffsetMin}" title="e.g. 60 for CET, 120 for CEST"></label>
            <label class="lib-field"><span>Extra folders to skip (regex, comma separated)</span>
              <input class="input" data-k="derived" value="${esc(p.derivedDirs.join(', '))}" placeholder="e.g. backup.*, test"></label>
            <label class="lib-check"><input type="checkbox" data-k="tables"${this.#importTables ? ' checked' : ''}> Import BirdNET/Raven tables found next to the recordings as a result run</label>
            <div class="lib-row"><button class="btn btn--primary" data-act="run-import"${canImport ? '' : ' disabled'}>Import</button>
              <span class="lib-import-status">${esc(this.#status)}</span></div>
          </div>
          <div class="lib-import-preview">${this.#renderPreview()}</div>`;
        this.#renderMappings();
    }
}
