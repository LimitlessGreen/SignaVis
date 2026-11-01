/**
 * RecordingExplorer — folder tree of the project's recordings (see app/recording-tree.ts).
 *
 * Structure:
 *   ▾ Project name                 ← collapsible header
 *     ▾ 📁 garden/                 ← real sub-folders of the project folder
 *         a2.wav  XC5           3  ← linked to an XC recording
 *     ▾ 🌐 Xeno-canto              ← virtual folder for XC downloads
 *       ▶ XC12345 · Turdus merula  5 · 8🔒 (own · imported)
 *     [+] Add XC recording…
 *
 * Usage:
 *   const explorer = new RecordingExplorer({
 *     container:   document.getElementById('recordingExplorerMount'),
 *     manager:     recordingManager,
 *     getSetName:  () => 'My Annotations',
 *     onActivate:  async (entry) => { ... },
 *     onAddXc:     async (xcId) => { ... },
 *   });
 *   explorer.render();
 */

import { toXcId } from '../../domain/xc/xcId.ts';
import { buildRecordingTree, folderPathOf, countRecordings, recordingName, isXcDownload, type TreeNode } from '../../app/recording-tree.ts';
import { showContextMenu } from '../components/context-menu/context-menu.ts';

const MULTI_MODE_KEY = 'signavis.multi-recording.v1';
const OPEN_FOLDERS_KEY = 'signavis.explorer-open-folders.v1';

export class RecordingExplorer {
    // TypeScript property declarations (migrated from JS)
    _collapsed: any;
    _container: any;
    _getSetName: any;
    _getSetStatus: any;
    _getOwnSetId: any;
    _manager: any;
    _onActivate: any;
    _onAddXc: any;
    _onRenameSet: any;
    _onResetRecording: any;
    _onResetSet: any;
    _onRemoveRecording: any;
    _getEntryLabels: any;
    _getSetInfo: any;
    _isSetHidden: any;
    _onToggleSetHidden: any;
    _onAdoptSet: any;
    _multiMode: boolean;
    _openFolders: Set<string>;
    _getProjectName: any;
    /**
     * @param {object} opts
     * @param {HTMLElement}   opts.container
     * @param {import('./recording-manager.js').RecordingManager} opts.manager
     * @param {() => string}  opts.getSetName
     * @param {(entry: object) => Promise<void>}  opts.onActivate
     * @param {(xcId: string) => Promise<void>}   [opts.onAddXc]
     * @param {(entry: object) => void}            [opts.onResetRecording]  Clear annotations for one recording
     * @param {() => void}                         [opts.onResetSet]        Clear annotations for all recordings
     * @param {(entry) => void}                    [opts.onRemoveRecording] Remove a recording (host may offer Undo)
     */
    constructor(opts: any) {
        this._container        = opts.container;
        this._manager          = opts.manager;
        this._getSetName       = opts.getSetName || (() => 'Annotations');
        this._getSetStatus     = opts.getSetStatus || null;
        this._getOwnSetId      = opts.getOwnSetId || (() => null);
        this._onRenameSet      = opts.onRenameSet || null;
        this._onActivate       = opts.onActivate;
        this._onAddXc          = opts.onAddXc || null;
        this._onResetRecording = opts.onResetRecording || null;
        this._onResetSet       = opts.onResetSet || null;
        this._onRemoveRecording = opts.onRemoveRecording || null;
        this._getEntryLabels   = opts.getEntryLabels || null;
        this._getSetInfo       = opts.getSetInfo || null;
        this._isSetHidden      = opts.isSetHidden || null;
        this._onToggleSetHidden = opts.onToggleSetHidden || null;
        this._onAdoptSet       = opts.onAdoptSet || null;
        this._collapsed        = false;
        this._getProjectName   = opts.getProjectName || null;
        try { this._openFolders = new Set(JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) || '[]')); } catch { this._openFolders = new Set(); }
        try { this._multiMode = localStorage.getItem(MULTI_MODE_KEY) === '1'; } catch { this._multiMode = false; }

        this._manager.addEventListener('change',       () => this.render());
        this._manager.addEventListener('activechange', () => this.render());
    }

    /** "⋯" button opening a context menu with the given items. */
    _menuButton(title: string, items: () => any[]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'recording-explorer-menu';
        btn.title = title;
        btn.setAttribute('aria-haspopup', 'menu');
        btn.textContent = '⋯';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const r = btn.getBoundingClientRect();
            showContextMenu({ x: r.left, y: r.bottom, items: items() });
        });
        return btn;
    }

    _promptXcId(entry: any) {
        const val = prompt(`XC number for ${entry.filename} (your own upload):`, entry.xcId || '');
        if (val == null) return;
        if (!this._manager.assignXcId(entry.id, val)) alert('Not a valid XC number.');
    }

    /** True when new recordings are added to the session instead of replacing the current one. */
    isMultiMode() { return this._multiMode || this._manager.getAll().length > 1; }

    /** Multi-recording labeling: the tree and its controls show only once this is on. */
    setMultiMode(on: boolean) {
        this._multiMode = on;
        try { localStorage.setItem(MULTI_MODE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
        this.render();
    }

    /** Single-recording view: one big button that switches multi-recording labeling on. */
    _renderSingleMode(container: HTMLElement) {
        const wrap = document.createElement('div');
        wrap.className = 'recording-explorer recording-explorer--single';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rec-multi-start';
        btn.innerHTML = '<span class="rec-multi-start-title">＋ Work with several recordings</span>'
            + '<span class="rec-multi-start-sub">Project folder or several Xeno-canto recordings</span>';
        btn.addEventListener('click', () => this.setMultiMode(true));
        wrap.appendChild(btn);
        container.appendChild(wrap);
    }

    render() {
        const container = this._container;
        if (!container) return;
        container.innerHTML = '';

        // Sessions that already hold several recordings always show the tree
        if (!this.isMultiMode()) { this._renderSingleMode(container); return; }

        const wrap = document.createElement('div');
        wrap.className = 'recording-explorer';

        // ── Set header (parent node) ──────────────────────────────────
        const header = document.createElement('div');
        header.className = 'rec-session-header';
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', String(!this._collapsed));
        header.tabIndex = 0;

        const chevron = document.createElement('span');
        chevron.className = 'rec-session-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = this._collapsed ? '▸' : '▾';

        const nameEl = document.createElement('span');
        nameEl.className = 'rec-session-name';
        // Project name as the root (folder feeling); older hosts without it still show the set name
        const projectName = this._getProjectName?.() || '';
        nameEl.textContent = projectName || this._getSetName();
        nameEl.title = projectName ? 'Project' : 'Click to rename set';

        // Inline rename support: if parent app provides onRenameSet, allow
        // editing the session set name directly from the explorer header.
        nameEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!this._onRenameSet || projectName) return;
            if (nameEl.querySelector('input')) return; // already editing
            const oldName = this._getSetName() || '';
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.className = 'inline-name-input';
            inp.value = oldName;
            inp.style.cssText = 'max-width:160px;font-size:12px;';
            nameEl.textContent = '';
            nameEl.appendChild(inp);
            inp.focus(); inp.select();
            const commit = () => {
                const val = inp.value.trim();
                if (val && val !== oldName) this._onRenameSet(val);
                nameEl.textContent = val || oldName;
            };
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                if (ev.key === 'Escape') { ev.preventDefault(); nameEl.textContent = oldName; }
            });
            inp.addEventListener('click', (ev) => ev.stopPropagation());
        });

        header.appendChild(chevron);
        header.appendChild(nameEl);

        // Status of the own set: draft → ready → uploaded
        const status = projectName ? null : this._getSetStatus?.();
        if (status) {
            const badge = document.createElement('span');
            badge.className = `rec-session-status rec-session-status--${status}`;
            badge.textContent = status;
            badge.title = status === 'uploaded'
                ? 'Uploaded to Xeno-canto — further changes need delete + re-upload on XC'
                : status === 'ready' ? 'No errors — ready to upload' : 'Draft';
            header.appendChild(badge);
        }

        // ── Session menu (hover-visible) — deletions go through the host, which offers Undo ──
        // Back to the single-recording view — only while at most one recording is in the session
        const single = document.createElement('button');
        single.type = 'button';
        single.className = 'tb-btn ghost rec-single-btn';
        single.textContent = 'Single';
        const canSingle = this._manager.getAll().length <= 1;
        single.disabled = !canSingle;
        single.title = canSingle ? 'Back to single-recording view' : 'Remove other recordings first';
        single.addEventListener('click', (e) => { e.stopPropagation(); this.setMultiMode(false); });
        header.appendChild(single);

        if (this._onResetSet) {
            header.appendChild(this._menuButton('Session actions', () => [
                { label: 'Clear all labels in this session', danger: true, action: () => this._onResetSet() },
            ]));
        }

        const toggle = () => {
            this._collapsed = !this._collapsed;
            chevron.textContent = this._collapsed ? '▸' : '▾';
            header.setAttribute('aria-expanded', String(!this._collapsed));
            body.hidden = this._collapsed;
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

        wrap.appendChild(header);

        // ── Body (children) ───────────────────────────────────────────
        const body = document.createElement('div');
        body.className = 'rec-session-body';
        body.hidden = this._collapsed;

        const entries  = this._manager.getAll();
        const activeId = this._manager.activeId;

        if (entries.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'recording-explorer-empty';
            hint.textContent = 'No recordings — use + to add';
            body.appendChild(hint);
        } else {
            const list = document.createElement('ul');
            list.className = 'recording-explorer-list';

            const tree = buildRecordingTree(entries);
            for (const id of folderPathOf(tree, activeId)) this._openFolders.add(id);
            this._appendNodes(list, tree, activeId, 0);

            body.appendChild(list);
        }

        // ── "+" Add recording row ─────────────────────────────────────
        if (this._onAddXc) {
            const addRow = document.createElement('div');
            addRow.className = 'recording-explorer-add-row';
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'recording-explorer-add-btn';
            addBtn.title = 'Add a Xeno-canto recording';
            addBtn.innerHTML = '<span>+</span> Add XC recording…';
            addBtn.addEventListener('click', () => this._openAddPopover(addBtn));
            addRow.appendChild(addBtn);
            body.appendChild(addRow);
        }

        wrap.appendChild(body);
        container.appendChild(wrap);
    }

    /** One recording row (+ rows of its imported sets). */
    _buildRecordingRow(entry: any, activeId: any, depth: number) {
        const ownSetId = this._getOwnSetId?.();
        const li = document.createElement('li');
        li.className = 'recording-explorer-row';
        if (entry.id === activeId) li.classList.add('active');

        // Play indicator
        const icon = document.createElement('span');
        icon.className = 'recording-explorer-icon';
        icon.textContent = entry.id === activeId ? '▶' : ' ';
        icon.setAttribute('aria-hidden', 'true');

        // Label: file name (or XC ID in the Xeno-canto folder) + species; linked local files get an XC badge
        const label = document.createElement('span');
        label.className = 'recording-explorer-label';
        const meta0 = entry.xcRecordingMeta || {};
        const sciName = (meta0.gen && meta0.sp) ? `${meta0.gen} ${meta0.sp}` : (meta0.scientificName || meta0.sp || '');
        label.textContent = recordingName(entry) + (sciName ? ' · ' + sciName : '');
        label.title = entry.path || entry.filename || '';
        if (!isXcDownload(entry) && toXcId(entry.xcId)) {
            const badge = document.createElement('span');
            badge.className = 'recording-explorer-xc';
            badge.textContent = toXcId(entry.xcId);
            badge.title = 'Linked to this Xeno-canto recording';
            label.append(' ', badge);
        }

        // Label counts: own · imported (read-only)
        const anns = (this._getEntryLabels ? this._getEntryLabels(entry) : entry.annotations) || [];
        const nOwn = ownSetId ? anns.filter((a: any) => a.setId === ownSetId).length : anns.length;
        const nImported = anns.length - nOwn;
        const meta = document.createElement('span');
        meta.className = 'recording-explorer-meta';
        meta.textContent = nImported ? `${nOwn} · ${nImported}🔒` : String(nOwn);
        meta.title = `${nOwn} own label${nOwn === 1 ? '' : 's'}` + (nImported ? ` · ${nImported} imported (read-only)` : '');

        const rowItems = () => [
            { label: entry.xcId ? `Change XC number (${toXcId(entry.xcId)})…` : 'Assign XC number…',
              action: () => this._promptXcId(entry) },
            { separator: true },
            ...(this._onResetRecording ? [{ label: 'Clear labels of this recording', danger: true,
              action: () => this._onResetRecording(entry) }] : []),
            { label: 'Remove from session', danger: true,
              action: () => (this._onRemoveRecording ? this._onRemoveRecording(entry) : this._manager.remove(entry.id)) },
        ];
        const menuBtn = this._menuButton('Recording actions', rowItems);
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu({ x: e.clientX, y: e.clientY, items: rowItems() });
        });

        li.appendChild(icon);
        li.appendChild(label);
        li.appendChild(meta);
        li.appendChild(menuBtn);

        li.addEventListener('click', () => {
            if (entry.id !== activeId) this._onActivate?.(entry);
        });

        li.style.setProperty('--rec-depth', String(depth));
        const setRows = this._buildSetRows(entry, ownSetId);
        if (setRows) setRows.style.setProperty('--rec-depth', String(depth));
        return setRows ? [li, setRows] : [li];
    }

    /** Folders (collapsible, open state per folder) and recordings, depth-indented. */
    _appendNodes(list: HTMLElement, nodes: TreeNode[], activeId: any, depth: number) {
        for (const node of nodes) {
            if (node.kind === 'recording') {
                for (const el of this._buildRecordingRow(node.entry, activeId, depth)) list.appendChild(el);
                continue;
            }
            const open = this._openFolders.has(node.id);
            const li = document.createElement('li');
            li.className = 'recording-explorer-folder' + (node.virtual ? ' recording-explorer-folder--xc' : '');
            li.style.setProperty('--rec-depth', String(depth));
            li.setAttribute('role', 'button');
            li.setAttribute('aria-expanded', String(open));
            li.tabIndex = 0;
            const chev = document.createElement('span');
            chev.className = 'recording-explorer-chevron';
            chev.setAttribute('aria-hidden', 'true');
            chev.textContent = open ? '▾' : '▸';
            const name = document.createElement('span');
            name.className = 'recording-explorer-label';
            name.textContent = (node.virtual ? '🌐 ' : '📁 ') + node.name;
            name.title = node.virtual ? 'Xeno-canto recordings' : node.id;
            const meta = document.createElement('span');
            meta.className = 'recording-explorer-meta';
            meta.textContent = String(countRecordings(node));
            meta.title = 'Recordings in this folder';
            li.append(chev, name, meta);
            const toggle = () => {
                if (this._openFolders.has(node.id)) this._openFolders.delete(node.id);
                else this._openFolders.add(node.id);
                this._saveOpenFolders();
                this.render();
            };
            li.addEventListener('click', toggle);
            li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
            list.appendChild(li);
            if (open) this._appendNodes(list, node.children, activeId, depth + 1);
        }
    }

    _saveOpenFolders() {
        try { localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...this._openFolders])); } catch { /* ignore */ }
    }


    /**
     * Sub-rows under a recording: one per imported (read-only) set with labels in it,
     * e.g. the XC set of the recording. Shows that those labels are separate from the
     * own set, with an eye toggle and an "Adopt" action.
     */
    _buildSetRows(entry: any, ownSetId: any) {
        const labels: any[] = this._getEntryLabels ? this._getEntryLabels(entry) : (entry.annotations || []);
        const counts = new Map<string, number>();
        for (const l of labels) {
            if (!l.setId || l.setId === ownSetId) continue;
            counts.set(l.setId, (counts.get(l.setId) || 0) + 1);
        }
        if (!counts.size) return null;
        const li = document.createElement('li');
        li.className = 'recording-explorer-sets';
        for (const [setId, n] of counts) {
            const info = this._getSetInfo?.(setId) || {};
            const row = document.createElement('div');
            row.className = 'rec-set-row';
            const origin = info.origin === 'xeno-canto' ? 'XC' : info.origin === 'birdnet' ? 'BirdNET' : (info.origin || 'import');
            const hidden = !!this._isSetHidden?.(setId);
            if (hidden) row.classList.add('rec-set-row--hidden');

            const eye = document.createElement('button');
            eye.type = 'button';
            eye.className = 'rec-set-eye';
            eye.title = hidden ? 'Show these labels' : 'Hide these labels';
            eye.textContent = hidden ? '◌' : '●';
            eye.addEventListener('click', (e) => { e.stopPropagation(); this._onToggleSetHidden?.(setId); });

            const name = document.createElement('span');
            name.className = 'rec-set-name';
            name.innerHTML = `<span class="rec-set-origin">${origin}</span>`;
            name.append(` ${info.name || 'Imported set'}`);
            name.title = `${info.name || 'Imported set'}${info.creator ? ' — ' + info.creator : ''} · read-only, not part of your set`;

            const count = document.createElement('span');
            count.className = 'recording-explorer-meta';
            count.textContent = `🔒 ${n}`;
            count.title = `${n} read-only label${n === 1 ? '' : 's'}`;

            row.append(eye, name, count);
            if (this._onAdoptSet) {
                const adopt = document.createElement('button');
                adopt.type = 'button';
                adopt.className = 'tb-btn rec-set-adopt';
                adopt.textContent = 'Adopt';
                adopt.title = `Copy these ${n} labels into your own set`;
                adopt.addEventListener('click', (e) => { e.stopPropagation(); this._onAdoptSet(setId); });
                row.appendChild(adopt);
            }
            li.appendChild(row);
        }
        return li;
    }

    // ── Add popover ──────────────────────────────────────────────────────

    _openAddPopover(anchor: any) {
        document.querySelector('.recording-explorer-popover')?.remove();

        const pop = document.createElement('div');
        pop.className = 'recording-explorer-popover';

        const xcRow = document.createElement('div');
        xcRow.className = 'rec-pop-row';

        const xcInput = document.createElement('input');
        xcInput.type = 'text';
        xcInput.className = 'input rec-pop-input';
        xcInput.placeholder = 'XC ID (e.g. 12345)';

        // Inline hint shown when the recording is already in the session
        const hint = document.createElement('div');
        hint.className = 'rec-pop-hint';
        hint.hidden = true;

        const xcBtn = document.createElement('button');
        xcBtn.type = 'button';
        xcBtn.className = 'tb-btn';
        xcBtn.textContent = 'Load';

        const checkAndLoad = async () => {
            const raw = xcInput.value.trim();
            if (!raw) return;

            // Normalise the same way RecordingManager.findByXcId does
            const norm = raw.replace(/^xc/i, '').replace(/\D/g, '').replace(/^0+/, '') || '0';
            const existing = this._manager.findByXcId(norm);
            if (existing) {
                // Already in session — switch to it instead of re-fetching
                hint.textContent = `${toXcId(norm)} already in session`;
                hint.hidden = false;
                xcInput.style.outlineColor = 'var(--color-warning, #f59e0b)';
                setTimeout(() => {
                    pop.remove();
                    document.removeEventListener('pointerdown', close, true);
                    this._onActivate?.(existing);
                }, 900);
                return;
            }

            pop.remove();
            document.removeEventListener('pointerdown', close, true);
            await this._onAddXc(raw);
        };

        xcBtn.addEventListener('click', checkAndLoad);
        xcInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); checkAndLoad(); } });

        xcRow.appendChild(xcInput);
        xcRow.appendChild(xcBtn);
        pop.appendChild(xcRow);
        pop.appendChild(hint);

        const rect = anchor.getBoundingClientRect();
        pop.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:999`;
        document.body.appendChild(pop);

        setTimeout(() => xcInput.focus(), 0);

        // eslint-disable-next-line prefer-const
        let close: any;
        close = (e: any) => {
            if (!pop.contains(e.target) && e.target !== anchor) {
                pop.remove();
                document.removeEventListener('pointerdown', close, true);
            }
        };
        setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    }
}
