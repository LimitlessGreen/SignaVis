/**
 * RecordingExplorer — hierarchy slicer showing the annotation set and its recordings.
 *
 * Structure:
 *   ▾ Annotation Set Name       ← collapsible header
 *     ▶ XC12345 · Turdus merula  ← active recording (bold)
 *       XC67890 · Sylvia atricapilla    ×
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

import { showContextMenu } from '../components/context-menu/context-menu.ts';

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
        this._collapsed        = false;

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

    render() {
        const container = this._container;
        if (!container) return;
        container.innerHTML = '';

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
        nameEl.textContent = this._getSetName();
        nameEl.title = 'Click to rename set';

        // Inline rename support: if parent app provides onRenameSet, allow
        // editing the session set name directly from the explorer header.
        nameEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!this._onRenameSet) return;
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
        const status = this._getSetStatus?.();
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

            for (const entry of entries) {
                const li = document.createElement('li');
                li.className = 'recording-explorer-row';
                if (entry.id === activeId) li.classList.add('active');

                // Play indicator
                const icon = document.createElement('span');
                icon.className = 'recording-explorer-icon';
                icon.textContent = entry.id === activeId ? '▶' : ' ';
                icon.setAttribute('aria-hidden', 'true');

                // Label
                const label = document.createElement('span');
                label.className = 'recording-explorer-label';
                const xcTag = entry.xcId ? `XC${entry.xcId}` : '';
                const species = entry.xcRecordingMeta?.scientificName
                    || entry.xcRecordingMeta?.sp
                    || '';
                const gen = entry.xcRecordingMeta?.gen || '';
                const sciName = (gen && entry.xcRecordingMeta?.sp)
                    ? `${gen} ${entry.xcRecordingMeta.sp}` : species;
                label.textContent = xcTag + (sciName ? ' · ' + sciName : (!xcTag ? entry.filename : ''));
                label.title = entry.filename;

                // Own-set labels in this recording; recordings without XC number can't be uploaded
                const ownSetId = this._getOwnSetId?.();
                const anns = entry.annotations || [];
                const nOwn = ownSetId ? anns.filter((a: any) => a.setId === ownSetId).length : anns.length;
                const meta = document.createElement('span');
                meta.className = 'recording-explorer-meta';
                meta.textContent = String(nOwn);
                meta.title = `${nOwn} label${nOwn === 1 ? '' : 's'} in your set`;
                if (!entry.xcId) {
                    meta.textContent += ' ⚠';
                    meta.title += ' · no XC number — cannot be uploaded';
                    meta.classList.add('recording-explorer-meta--warn');
                    meta.title += ' (click to assign)';
                    meta.addEventListener('click', (e) => { e.stopPropagation(); this._promptXcId(entry); });
                }

                const rowItems = () => [
                    { label: entry.xcId ? `Change XC number (XC${entry.xcId})…` : 'Assign XC number…',
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

                list.appendChild(li);
            }

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
                hint.textContent = `XC${norm} already in session`;
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
