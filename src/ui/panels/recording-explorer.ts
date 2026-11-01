/**
 * RecordingExplorer — folder tree of the project's recordings (see app/recording-tree.ts).
 *
 * Structure:
 *   ▾ Project name                 ← collapsible header
 *     ▾ 📁 garden/                 ← real sub-folders of the project folder
 *         a2.wav  XC5           3  ← linked to an XC recording
 *     ▾ 🌐 Xeno-canto              ← virtual folder for XC downloads
 *       ▾ 📦 Annotation sets       ← XC annotation sets, one row per set
 *         ▾ ● Dawn chorus · me  3 rec · 🔒 42   ← highlighted while one of its recordings is active
 *             ▶ XC12345            🔒 12
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
import { XC_FOLDER_ID, buildRecordingTree, folderPathOf, countRecordings, recordingName, isXcDownload, folderContents, type TreeNode, type TreeFolder } from '../../app/recording-tree.ts';
import { showContextMenu } from '../components/context-menu/context-menu.ts';
import { appAlert, appPrompt } from '../components/modal/dialogs.ts';
import { labelsToAdopt } from '../../app/annotation-sets.ts';

const MULTI_MODE_KEY = 'signavis.multi-recording.v1';
const OPEN_FOLDERS_KEY = 'signavis.explorer-open-folders.v1';
const XC_SETS_FOLDER_ID = '@xc-sets';
const xcSetNodeId = (setId: string) => `@xc-set:${setId}`;

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
    _getFolderFiles: any;
    _isProjectFolder: () => boolean;
    _onOpenFile: any;
    _onFolderKeepAll: any;
    _onFolderBirdnet: any;
    _getMissingContext: any;
    _onOpenContext: any;
    _xcSets: Map<string, any> = new Map();
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
        /** Audio files of the project folder without a recording entry yet ({ path, size }[]). */
        this._getFolderFiles   = opts.getFolderFiles || (() => []);
        /** True while the project lives in a folder: the tree is always shown there. */
        this._isProjectFolder  = opts.isProjectFolder || (() => false);
        /** Open such a file (host creates the entry and loads it). */
        this._onOpenFile       = opts.onOpenFile || null;
        /** Folder menu: keep all ({ entries, paths }) / run BirdNET on all recordings (entries + paths). */
        this._onFolderKeepAll  = opts.onFolderKeepAll || null;
        this._onFolderBirdnet  = opts.onFolderBirdnet || null;
        // (entry) => string[] of missing context fields, e.g. ['location', 'date']
        this._getMissingContext = opts.getMissingContext || null;
        this._onOpenContext    = opts.onOpenContext || null;
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

    async _promptXcId(entry: any) {
        const val = await appPrompt(`XC number for ${entry.filename} (your own upload):`, entry.xcId || '', { title: 'Assign XC number', placeholder: 'XC123456' });
        if (val == null) return;
        if (!this._manager.assignXcId(entry.id, val)) await appAlert('Not a valid XC number.', { title: 'Assign XC number' });
    }

    /** True when new recordings are added to the session instead of replacing the current one. */
    isMultiMode() {
        return this._multiMode || this._isProjectFolder() || this._manager.getAll().length > 1
            || (this._getFolderFiles() || []).length > 0;
    }

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

        // Status of the own labels (local check): draft → ready — only without a project name
        const status = projectName ? null : this._getSetStatus?.();
        if (status) {
            const badge = document.createElement('span');
            badge.className = `rec-session-status rec-session-status--${status}`;
            badge.textContent = status;
            badge.title = status === 'ready' ? 'No errors — ready to upload' : 'Draft';
            header.appendChild(badge);
        }

        // ── Session menu (hover-visible) — deletions go through the host, which offers Undo ──
        // Back to the single-recording view — only while at most one recording is in the session
        const single = document.createElement('button');
        single.type = 'button';
        single.className = 'tb-btn ghost rec-single-btn';
        single.textContent = 'Single';
        const canSingle = this._manager.getAll().length <= 1;
        // A project folder always shows its tree — no single-recording view
        single.hidden = this._isProjectFolder() || (this._getFolderFiles() || []).length > 0;
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

        const folderFiles = this._getFolderFiles() || [];
        if (entries.length === 0 && !folderFiles.length) {
            const hint = document.createElement('div');
            hint.className = 'recording-explorer-empty';
            hint.textContent = 'No recordings — use + to add';
            body.appendChild(hint);
        } else {
            const list = document.createElement('ul');
            list.className = 'recording-explorer-list';

            const tree = buildRecordingTree(entries, folderFiles, { localName: this._getProjectName?.() || 'Project folder' });
            this._xcSets = this._collectXcSets(entries);
            // XC sets may sit only on linked local files: the Xeno-canto folder must still exist
            if (this._xcSets.size && !tree.some((n) => n.kind === 'folder' && n.virtual === 'xc')) {
                const iSession = tree.findIndex((n) => n.kind === 'folder' && n.virtual === 'session');
                tree.splice(iSession < 0 ? tree.length : iSession, 0, { kind: 'folder', id: XC_FOLDER_ID, name: 'Xeno-canto', virtual: 'xc', children: [] });
            }
            for (const id of folderPathOf(tree, activeId)) this._openFolders.add(id);
            // Set of the active recording: unfold down to it, so the active entry is visible there too
            for (const [setId, set] of this._xcSets) {
                if (set.recs.some((r: any) => r.entry.id === activeId)) {
                    this._openFolders.add(XC_FOLDER_ID).add(XC_SETS_FOLDER_ID).add(xcSetNodeId(setId));
                }
            }
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
        const missing = this._getMissingContext?.(entry) || [];
        if (missing.length) {
            const warn = document.createElement('button');
            warn.type = 'button';
            warn.className = 'recording-explorer-ctx';
            warn.textContent = '📍';
            warn.title = `No ${missing.join(' / ')} — click to set it in Properties`;
            warn.addEventListener('click', (e) => { e.stopPropagation(); this._onOpenContext?.(entry); });
            li.appendChild(warn);
        }
        li.appendChild(meta);
        // Opened but neither labeled nor kept: dimmed, "+" keeps it in the project
        if (entry.pinned === false && anns.length === 0) {
            li.classList.add('recording-explorer-row--transient');
            const keep = document.createElement('button');
            keep.type = 'button';
            keep.className = 'recording-explorer-keep';
            keep.textContent = '+';
            keep.title = 'Keep in project (otherwise it is kept only once it has a label)';
            keep.addEventListener('click', (e) => { e.stopPropagation(); this._manager.update(entry.id, { pinned: true }); this.render(); });
            li.appendChild(keep);
        }
        li.appendChild(menuBtn);

        li.addEventListener('click', () => {
            if (entry.id !== activeId) this._onActivate?.(entry);
        });

        li.style.setProperty('--rec-depth', String(depth));
        return [li, ...this._buildSetRows(entry, ownSetId, depth + 1)];
    }

    /** Folders (collapsible, open state per folder) and recordings, depth-indented. */
    _appendNodes(list: HTMLElement, nodes: TreeNode[], activeId: any, depth: number) {
        for (const node of nodes) {
            if (node.kind === 'recording') {
                for (const el of this._buildRecordingRow(node.entry, activeId, depth)) list.appendChild(el);
                continue;
            }
            if (node.kind === 'file') { list.appendChild(this._buildFileRow(node, depth)); continue; }
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
            name.textContent = (node.virtual === 'xc' ? '🌐 ' : node.virtual === 'session' ? '🗂 ' : '📁 ') + node.name;
            name.title = node.virtual === 'xc' ? 'Xeno-canto recordings'
                : node.virtual === 'local' ? 'Project folder'
                : node.virtual === 'session' ? 'Files opened in this session (not stored in a project folder)' : node.id;
            const meta = document.createElement('span');
            meta.className = 'recording-explorer-meta';
            meta.textContent = String(countRecordings(node));
            meta.title = 'Recordings in this folder';
            li.append(chev, name, meta);
            const items = this._folderMenuItems(node);
            if (items.length) {
                li.appendChild(this._menuButton('Folder actions', () => this._folderMenuItems(node)));
                li.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    showContextMenu({ x: e.clientX, y: e.clientY, items: this._folderMenuItems(node) });
                });
            }
            const toggle = () => {
                if (this._openFolders.has(node.id)) this._openFolders.delete(node.id);
                else this._openFolders.add(node.id);
                this._saveOpenFolders();
                this.render();
            };
            li.addEventListener('click', toggle);
            li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
            list.appendChild(li);
            if (open && node.virtual === 'xc') this._appendXcSets(list, activeId, depth + 1);
            if (open) this._appendNodes(list, node.children, activeId, depth + 1);
        }
    }

    _folderMenuItems(node: TreeFolder) {
        const { entries, files } = folderContents(node);
        const items: any[] = [];
        const unkept = entries.filter((e) => e.pinned === false);
        if (this._onFolderKeepAll && (files.length || unkept.length)) {
            const n = files.length + unkept.length;
            items.push({ label: `Keep all files in the project (${n})`,
                action: () => this._onFolderKeepAll({ entries: unkept, paths: files.map((f) => f.path) }) });
        }
        const total = entries.length + files.length;
        if (this._onFolderBirdnet && total) {
            items.push({ label: `Run BirdNET on this folder (${total} recording${total === 1 ? '' : 's'})…`,
                action: () => this._onFolderBirdnet({ entries, paths: files.map((f) => f.path) }) });
        }
        return items;
    }

    /** Audio file of the project folder that was never opened: click opens it. */
    _buildFileRow(node: { path: string; name: string; size?: number }, depth: number) {
        const li = document.createElement('li');
        li.className = 'recording-explorer-row recording-explorer-row--file';
        li.style.setProperty('--rec-depth', String(depth));
        li.tabIndex = 0;
        li.title = `${node.path} — click to open`;
        const icon = document.createElement('span');
        icon.className = 'recording-explorer-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = ' ';
        const label = document.createElement('span');
        label.className = 'recording-explorer-label';
        label.textContent = node.name;
        const meta = document.createElement('span');
        meta.className = 'recording-explorer-meta';
        if (node.size) meta.textContent = node.size >= 1048576 ? `${(node.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(node.size / 1024))} kB`;
        li.append(icon, label, meta);
        const open = () => this._onOpenFile?.(node.path, { pin: false });
        li.addEventListener('click', open);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } });
        return li;
    }

    _saveOpenFolders() {
        try { localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...this._openFolders])); } catch { /* ignore */ }
    }


    /**
     * Child rows under a recording, one level deeper: one per imported (read-only) set with labels
     * on it, e.g. the XC labels of the recording. Eye = show/hide; "Copy to mine" copies the labels
     * not copied yet into the own labels, afterwards the row says "✓ in mine".
     */
    _buildSetRows(entry: any, ownSetId: any, depth: number): HTMLElement[] {
        const labels: any[] = (this._getEntryLabels ? this._getEntryLabels(entry) : entry.annotations) || [];
        const bySet = new Map<string, any[]>();
        for (const l of labels) {
            if (!l.setId || l.setId === ownSetId) continue;
            if (this._isXcSet(l.setId)) continue;   // shown in Xeno-canto › Annotation sets
            if (!bySet.has(l.setId)) bySet.set(l.setId, []);
            bySet.get(l.setId)!.push(l);
        }
        const rows: HTMLElement[] = [];
        for (const [setId, inSet] of bySet) {
            const n = inSet.length;
            const info = this._getSetInfo?.(setId) || {};
            const origin = info.origin === 'xeno-canto' ? 'XC' : info.origin === 'birdnet' ? 'BirdNET' : (info.origin || 'import');
            const hidden = !!this._isSetHidden?.(setId);
            const pending = ownSetId ? labelsToAdopt(inSet, labels, ownSetId).length : n;

            const li = document.createElement('li');
            li.className = 'recording-explorer-row recording-explorer-row--set';
            if (hidden) li.classList.add('rec-set-row--hidden');
            li.style.setProperty('--rec-depth', String(depth));

            const eye = document.createElement('button');
            eye.type = 'button';
            eye.className = 'rec-set-eye';
            eye.title = hidden ? 'Show these labels' : 'Hide these labels';
            eye.setAttribute('aria-pressed', String(!hidden));
            eye.textContent = hidden ? '◌' : '●';
            eye.addEventListener('click', (e) => { e.stopPropagation(); this._onToggleSetHidden?.(setId); });

            const name = document.createElement('span');
            name.className = 'rec-set-name';
            const badge = document.createElement('span');
            badge.className = 'rec-set-origin';
            badge.textContent = origin;
            const setName = info.name || 'Imported labels';
            name.append(badge, ` ${setName}`);
            if (info.creator) {
                const by = document.createElement('span');
                by.className = 'rec-set-creator';
                by.textContent = ` · ${info.creator}`;
                name.append(by);
            }
            name.title = `${setName}${info.creator ? ' — ' + info.creator : ''} · read-only, separate from your labels`;

            const count = document.createElement('span');
            count.className = 'recording-explorer-meta';
            count.textContent = `🔒 ${n}`;
            count.title = `${n} read-only label${n === 1 ? '' : 's'}`;

            li.append(eye, name, count);
            if (this._onAdoptSet) {
                if (pending) {
                    const copy = document.createElement('button');
                    copy.type = 'button';
                    copy.className = 'link-btn rec-set-adopt';
                    copy.textContent = pending < n ? `Copy ${pending} more` : 'Copy to mine';
                    copy.title = `Copy ${pending} label${pending === 1 ? '' : 's'} into your own labels (editable, undo possible)`;
                    copy.addEventListener('click', (e) => {
                        e.stopPropagation();
                        copy.disabled = true;   // no double copies from fast clicks; render() rebuilds the row
                        this._onAdoptSet(setId);
                    });
                    li.appendChild(copy);
                } else {
                    const done = document.createElement('span');
                    done.className = 'rec-set-adopted';
                    done.textContent = '✓ in mine';
                    done.title = 'All these labels are copied into your own labels';
                    li.appendChild(done);
                }
            }
            // Click on the row opens its recording, like the recording row itself
            li.addEventListener('click', () => { if (entry.id !== this._manager.activeId) this._onActivate?.(entry); });
            rows.push(li);
        }
        return rows;
    }

    _isXcSet(setId: string) { return this._getSetInfo?.(setId)?.origin === 'xeno-canto'; }

    /** XC annotation sets of the session: setId → { info, recs: [{ entry, labels, all }] }. */
    _collectXcSets(entries: any[]) {
        const out = new Map<string, any>();
        const ownSetId = this._getOwnSetId?.();
        for (const entry of entries) {
            const all: any[] = (this._getEntryLabels ? this._getEntryLabels(entry) : entry.annotations) || [];
            const bySet = new Map<string, any[]>();
            for (const l of all) {
                if (!l?.setId || l.setId === ownSetId || !this._isXcSet(l.setId)) continue;
                if (!bySet.has(l.setId)) bySet.set(l.setId, []);
                bySet.get(l.setId)!.push(l);
            }
            for (const [setId, labels] of bySet) {
                if (!out.has(setId)) out.set(setId, { info: this._getSetInfo?.(setId) || {}, recs: [] });
                out.get(setId).recs.push({ entry, labels, all });
            }
        }
        for (const set of out.values()) {
            set.recs.sort((a: any, b: any) => recordingName(a.entry).localeCompare(recordingName(b.entry), undefined, { numeric: true }));
        }
        return new Map([...out].sort((a, b) => String(a[1].info.name || '').localeCompare(String(b[1].info.name || ''))));
    }

    /** "📦 Annotation sets" sub-folder of Xeno-canto: one collapsible row per set, its recordings below. */
    _appendXcSets(list: HTMLElement, activeId: any, depth: number) {
        if (!this._xcSets.size) return;
        const ownSetId = this._getOwnSetId?.();
        const folderOpen = this._openFolders.has(XC_SETS_FOLDER_ID);
        const toggleId = (id: string) => () => {
            if (this._openFolders.has(id)) this._openFolders.delete(id); else this._openFolders.add(id);
            this._saveOpenFolders();
            this.render();
        };
        const folder = document.createElement('li');
        folder.className = 'recording-explorer-folder';
        folder.style.setProperty('--rec-depth', String(depth));
        folder.setAttribute('role', 'button');
        folder.setAttribute('aria-expanded', String(folderOpen));
        folder.tabIndex = 0;
        const chev = document.createElement('span');
        chev.className = 'recording-explorer-chevron';
        chev.setAttribute('aria-hidden', 'true');
        chev.textContent = folderOpen ? '▾' : '▸';
        const name = document.createElement('span');
        name.className = 'recording-explorer-label';
        name.textContent = '📦 Annotation sets';
        name.title = 'Finished annotation sets imported from Xeno-canto (read-only)';
        const meta = document.createElement('span');
        meta.className = 'recording-explorer-meta';
        meta.textContent = String(this._xcSets.size);
        meta.title = 'Sets';
        folder.append(chev, name, meta);
        const t = toggleId(XC_SETS_FOLDER_ID);
        folder.addEventListener('click', t);
        folder.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t(); } });
        list.appendChild(folder);
        if (!folderOpen) return;

        for (const [setId, set] of this._xcSets) {
            const nodeId = xcSetNodeId(setId);
            const open = this._openFolders.has(nodeId);
            const info = set.info;
            const hidden = !!this._isSetHidden?.(setId);
            const nLabels = set.recs.reduce((s: number, r: any) => s + r.labels.length, 0);
            const pending = set.recs.reduce((s: number, r: any) =>
                s + (ownSetId ? labelsToAdopt(r.labels, r.all, ownSetId).length : r.labels.length), 0);
            const isActive = set.recs.some((r: any) => r.entry.id === activeId);

            const li = document.createElement('li');
            li.className = 'recording-explorer-row recording-explorer-row--set rec-xc-set';
            if (isActive) li.classList.add('rec-xc-set--active');
            if (hidden) li.classList.add('rec-set-row--hidden');
            li.style.setProperty('--rec-depth', String(depth + 1));
            li.setAttribute('aria-expanded', String(open));
            li.title = isActive ? 'Contains the active recording' : '';
            const c = document.createElement('span');
            c.className = 'recording-explorer-chevron';
            c.setAttribute('aria-hidden', 'true');
            c.textContent = open ? '▾' : '▸';
            const eye = document.createElement('button');
            eye.type = 'button';
            eye.className = 'rec-set-eye';
            eye.title = hidden ? 'Show these labels' : 'Hide these labels';
            eye.setAttribute('aria-pressed', String(!hidden));
            eye.textContent = hidden ? '◌' : '●';
            eye.addEventListener('click', (e) => { e.stopPropagation(); this._onToggleSetHidden?.(setId); });
            const nm = document.createElement('span');
            nm.className = 'rec-set-name';
            const setName = info.name || 'XC annotation set';
            nm.append(setName);
            if (info.creator) {
                const by = document.createElement('span');
                by.className = 'rec-set-creator';
                by.textContent = ` · ${info.creator}`;
                nm.append(by);
            }
            nm.title = `${setName}${info.creator ? ' — ' + info.creator : ''} · read-only, separate from your labels`;
            const nRec = set.recs.length;
            const cnt = document.createElement('span');
            cnt.className = 'recording-explorer-meta';
            cnt.textContent = `${nRec} rec · 🔒 ${nLabels}`;
            cnt.title = `${nRec} recording${nRec === 1 ? '' : 's'} · ${nLabels} read-only label${nLabels === 1 ? '' : 's'}`;
            li.append(c, eye, nm, cnt);
            if (this._onAdoptSet) {
                if (pending) {
                    const copy = document.createElement('button');
                    copy.type = 'button';
                    copy.className = 'link-btn rec-set-adopt';
                    copy.textContent = pending < nLabels ? `Copy ${pending} more` : 'Copy to mine';
                    copy.title = `Copy ${pending} label${pending === 1 ? '' : 's'} of all recordings of this set into your own labels (editable, undo possible)`;
                    copy.addEventListener('click', (e) => { e.stopPropagation(); copy.disabled = true; this._onAdoptSet(setId); });
                    li.appendChild(copy);
                } else {
                    const done = document.createElement('span');
                    done.className = 'rec-set-adopted';
                    done.textContent = '✓ in mine';
                    done.title = 'All labels of this set are copied into your own labels';
                    li.appendChild(done);
                }
            }
            li.addEventListener('click', toggleId(nodeId));
            list.appendChild(li);
            if (!open) continue;

            for (const r of set.recs) {
                const row = document.createElement('li');
                row.className = 'recording-explorer-row rec-xc-set-rec';
                if (r.entry.id === activeId) row.classList.add('active');
                row.style.setProperty('--rec-depth', String(depth + 2));
                const icon = document.createElement('span');
                icon.className = 'recording-explorer-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = r.entry.id === activeId ? '▶' : ' ';
                const lab = document.createElement('span');
                lab.className = 'recording-explorer-label';
                const m = r.entry.xcRecordingMeta || {};
                const sci = (m.gen && m.sp) ? `${m.gen} ${m.sp}` : (m.scientificName || '');
                const recName = isXcDownload(r.entry) ? recordingName(r.entry) : (toXcId(r.entry.xcId) || recordingName(r.entry));
                lab.textContent = recName + (sci ? ' · ' + sci : '');
                lab.title = r.entry.path || r.entry.filename || '';
                const mm = document.createElement('span');
                mm.className = 'recording-explorer-meta';
                mm.textContent = `🔒 ${r.labels.length}`;
                mm.title = `${r.labels.length} label${r.labels.length === 1 ? '' : 's'} of this set on this recording`;
                row.append(icon, lab, mm);
                row.addEventListener('click', () => { if (r.entry.id !== this._manager.activeId) this._onActivate?.(r.entry); });
                list.appendChild(row);
            }
        }
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
