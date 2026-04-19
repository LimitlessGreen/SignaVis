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

export class RecordingExplorer {
    /**
     * @param {object} opts
     * @param {HTMLElement}   opts.container
     * @param {import('./recording-manager.js').RecordingManager} opts.manager
     * @param {() => string}  opts.getSetName
     * @param {(entry: object) => Promise<void>}  opts.onActivate
     * @param {(xcId: string) => Promise<void>}   [opts.onAddXc]
     * @param {(entry: object) => void}            [opts.onResetRecording]  Clear annotations for one recording
     * @param {() => void}                         [opts.onResetSet]        Clear annotations for all recordings
     */
    constructor(opts) {
        this._container        = opts.container;
        this._manager          = opts.manager;
        this._getSetName       = opts.getSetName || (() => 'Annotations');
        this._onActivate       = opts.onActivate;
        this._onAddXc          = opts.onAddXc || null;
        this._onResetRecording = opts.onResetRecording || null;
        this._onResetSet       = opts.onResetSet || null;
        this._collapsed        = false;

        this._manager.addEventListener('change',       () => this.render());
        this._manager.addEventListener('activechange', () => this.render());
    }

    render() {
        const container = this._container;
        if (!container) return;
        container.innerHTML = '';

        const wrap = document.createElement('div');
        wrap.className = 'recording-explorer';

        // ── Set header (parent node) ──────────────────────────────────
        const header = document.createElement('div');
        header.className = 'rec-set-header';
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', String(!this._collapsed));
        header.tabIndex = 0;

        const chevron = document.createElement('span');
        chevron.className = 'rec-set-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = this._collapsed ? '▸' : '▾';

        const nameEl = document.createElement('span');
        nameEl.className = 'rec-set-name';
        nameEl.textContent = this._getSetName();

        header.appendChild(chevron);
        header.appendChild(nameEl);

        // ── Set-level reset button (hover-visible) ────────────────────
        if (this._onResetSet) {
            const resetSetBtn = document.createElement('button');
            resetSetBtn.type = 'button';
            resetSetBtn.className = 'recording-explorer-reset-set';
            resetSetBtn.title = 'Clear all annotations in this session';
            resetSetBtn.textContent = '↺';
            resetSetBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm('Clear all annotations for every recording in this session?')) {
                    await this._onResetSet();
                }
            });
            header.appendChild(resetSetBtn);
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
        body.className = 'rec-set-body';
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

                // Reset button (hover only) — clears annotations for this recording
                const resetBtn = document.createElement('button');
                resetBtn.type = 'button';
                resetBtn.className = 'recording-explorer-reset';
                resetBtn.title = 'Clear annotations for this recording';
                resetBtn.textContent = '↺';
                resetBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (confirm(`Clear all annotations for ${label.textContent}?`)) {
                        await this._onResetRecording?.(entry);
                    }
                });

                // Remove button (hover only)
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'recording-explorer-remove';
                removeBtn.title = 'Remove from session';
                removeBtn.innerHTML = '&times;';
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._manager.remove(entry.id);
                });

                li.appendChild(icon);
                li.appendChild(label);
                if (this._onResetRecording) li.appendChild(resetBtn);
                li.appendChild(removeBtn);

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

    _openAddPopover(anchor) {
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
        let close;
        close = (e) => {
            if (!pop.contains(e.target) && e.target !== anchor) {
                pop.remove();
                document.removeEventListener('pointerdown', close, true);
            }
        };
        setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    }
}
