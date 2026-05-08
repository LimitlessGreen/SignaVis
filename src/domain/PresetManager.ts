// ═══════════════════════════════════════════════════════════════════════
// PresetManager.ts — DSP preset CRUD, storage, quality slider, PCEN controls
//
// Owns:
//   • localStorage read/write for user presets, favourite, and last settings
//   • Reading and writing all DSP control inputs (scaleSelect, windowSizeSelect, …)
//   • Preset dropdown, favourite button, preset manager panel (CRUD/rename/export/import)
//   • Quality slider sync
//   • PCEN section dimming and colour-scale constraints
//   • currentColorScheme state (exposed via getter)
//
// Delegates back to PlayerState via two callbacks:
//   • onRegenerateSpectrogram(opts) — full FFT re-run needed
//   • onStage1Rebuild()             — display-only rebuild (no FFT)
// ═══════════════════════════════════════════════════════════════════════

import { DSP_PROFILES, QUALITY_LEVELS } from '../shared/constants.ts';
import { LocalStorageAdapter } from '../infrastructure/storage/LocalStorageAdapter.ts';
import { jsonGetItem, jsonSetItem } from '../shared/storageJson.ts';
import { readDspSettings, applyDspSettings } from './dsp/DspSettings.ts';

import type { IStorage } from '../infrastructure/storage/IStorage.ts';
import type { UndoCommand } from './undoStack.ts';

export interface PresetManagerCallbacks {
    onRegenerateSpectrogram: (opts?: any) => void;
    onStage1Rebuild: () => void;
    storage?: IStorage;
    onDspCommand?: ((cmd: UndoCommand) => void) | null;
}

const LS_USER_PRESETS  = 'aw-user-presets';
const LS_FAV_PRESET    = 'aw-favourite-preset';
const LS_LAST_SETTINGS = 'aw-last-settings';

export class PresetManager {
    value: any;
    options: any;
    disabled: any;
    checked: any;
    gainFloor: any;
    gainCeil: any;
    maxFreqHz: any;
    title: any;
    #d: any;
    #onRegen: (opts?: any) => void;
    #onStage1: () => void;
    #statusTimer = 0;
    #cleanups: Array<() => void> = [];
    #currentColorScheme = 'grayscale';
    #storage: IStorage;
    /**
     * Optional callback: called after every DSP parameter change with a command
     * object the caller can pass to an UndoStack via record().
     * @type {((cmd: import('./undoStack.ts').UndoCommand) => void) | null}
     */
    #onDspCommand: ((cmd: UndoCommand) => void) | null = null;
    /** Snapshot captured before a DSP change starts (for undo). */
    #dspBeforeSnapshot: any = null;

    /**
     * @param {object} d  Subset of PlayerState DOM-refs (all preset-related elements).
     * @param {object} callbacks
     * @param {(opts?: object) => void} callbacks.onRegenerateSpectrogram
     * @param {() => void}              callbacks.onStage1Rebuild
     * @param {import('../infrastructure/storage/IStorage.ts').IStorage} [callbacks.storage]
     *   Storage adapter — defaults to LocalStorageAdapter. Pass an InMemoryStorageAdapter
     *   for tests or headless environments.
     * @param {((cmd: import('./undoStack.ts').UndoCommand) => void) | null} [callbacks.onDspCommand]
     *   Called after each DSP parameter change with an undo/redo command object.
     *   Pass `undoStack.record.bind(undoStack)` to wire DSP changes into the undo stack.
     */
    constructor(d: any, { onRegenerateSpectrogram, onStage1Rebuild, storage, onDspCommand }: PresetManagerCallbacks) {
        this.#d          = d;
        this.#onRegen    = onRegenerateSpectrogram;
        this.#onStage1   = onStage1Rebuild;
        this.#storage    = storage ?? new LocalStorageAdapter();
        this.#onDspCommand = onDspCommand ?? null;
    }

    // ─────────────────────────────────────────────────────────────────
    //  Public API (called by PlayerState)
    // ─────────────────────────────────────────────────────────────────

    /** The current spectrogram colour scheme (kept in sync with the colorSchemeSelect). */
    get currentColorScheme() { return this.#currentColorScheme; }

    /**
     * Bind all preset/DSP-control event listeners.
     * The caller is responsible for removing them on dispose — pass the same
     * `on(target, type, fn)` helper used in PlayerState._bindEvents so that
     * cleanup is registered in the central _cleanups array.
     *
     * @param {(target: EventTarget, type: string, fn: EventListener) => void} on
     */
    bindEvents(on: (target: EventTarget, type: string, fn: EventListener) => void) {
        const d = this.#d;

        // ── Preset dropdown & buttons ──
        on(d.presetSelect, 'change', () => {
            const val = d.presetSelect?.value;
            if (val) this.applyPreset(val);
            this.updatePresetButtons();
            this.persistCurrentSettings();
        });
        on(d.presetSaveBtn,    'click',   () => this.#promptSaveUserPreset());
        on(d.presetFavBtn,     'click',   () => this.#toggleFavouritePreset());
        on(d.presetManageBtn,  'click',   () => this.#openPresetManager());
        on(d.presetSaveConfirm,'click',   () => this.#confirmSaveUserPreset());
        on(d.presetSaveCancel, 'click',   () => this.#cancelSaveUserPreset());
        on(d.presetSaveInput,  'keydown', (e: Event) => {
            const ev = e as KeyboardEvent;
            if (ev.key === 'Enter')  this.#confirmSaveUserPreset();
            if (ev.key === 'Escape') this.#cancelSaveUserPreset();
        });
        on(d.presetImportBtn, 'click', () => this.#importPresets());
        on(d.presetExportBtn, 'click', () => this.#exportPresets());

        // ── Quality slider ──
        on(d.qualitySlider, 'input', () => {
            this.applyQualityLevel(parseInt(d.qualitySlider.value, 10));
        });

        // ── Scale / colour-scale ──
        on(d.scaleSelect,      'pointerdown', () => this.#captureBeforeDsp());
        on(d.scaleSelect, 'change', () => {
            this.clearPresetHighlight();
            this.#onRegen({ autoAdjust: true });
            this.#commitDspCommand('Scale change');
        });
        on(d.colourScaleSelect, 'pointerdown', () => this.#captureBeforeDsp());
        on(d.colourScaleSelect, 'change', () => {
            this.clearPresetHighlight();
            this.updateColourScaleConstraints();
            this.#onRegen({ autoAdjust: true });
            this.#commitDspCommand('Colour scale change');
        });
        on(d.colorSchemeSelect, 'pointerdown', () => this.#captureBeforeDsp());
        on(d.colorSchemeSelect, 'change', () => {
            this.#currentColorScheme = d.colorSchemeSelect.value;
            this.persistCurrentSettings();
            this.#onStage1();
            this.#commitDspCommand('Colour scheme change');
        });

        // ── DSP controls that trigger a full re-run ──
        const DSP_CONTROLS = [
            { el: 'nMelsInput',          syncQuality: true,  desc: 'Mel bins change'       },
            { el: 'windowSizeSelect',    syncQuality: true,  desc: 'Window size change'     },
            { el: 'overlapSelect',       syncQuality: true,  desc: 'Overlap change'         },
            { el: 'oversamplingSelect',  syncQuality: true,  desc: 'Oversampling change'    },
            { el: 'windowFunctionSelect',syncQuality: false, desc: 'Window function change' },
            { el: 'reassignedCheck',     syncQuality: false, desc: 'Reassignment change'    },
            { el: 'pcenGainInput',       syncQuality: false, desc: 'PCEN gain change'       },
            { el: 'pcenBiasInput',       syncQuality: false, desc: 'PCEN bias change'       },
            { el: 'pcenRootInput',       syncQuality: false, desc: 'PCEN root change'       },
            { el: 'pcenSmoothingInput',  syncQuality: false, desc: 'PCEN smoothing change'  },
        ];
        for (const { el, syncQuality, desc } of DSP_CONTROLS) {
            if (!d[el]) continue;
            on(d[el], 'pointerdown', () => this.#captureBeforeDsp());
            on(d[el], 'focus',       () => this.#captureBeforeDsp());
            on(d[el], 'change', () => {
                this.clearPresetHighlight();
                if (syncQuality) this.syncQualitySlider();
                this.#onRegen();
                this.#commitDspCommand(desc);
            });
        }

        // PCEN enabled is special: also updates section dimming before re-run.
        if (d.pcenEnabledCheck) {
            on(d.pcenEnabledCheck, 'pointerdown', () => this.#captureBeforeDsp());
            on(d.pcenEnabledCheck, 'change', () => {
                this.updatePcenSectionDimming();
                this.clearPresetHighlight();
                this.#onRegen();
                this.#commitDspCommand('PCEN enabled change');
            });
        }

        // ── Stage-1-only controls ──
        on(d.noiseReductionCheck, 'pointerdown', () => this.#captureBeforeDsp());
        on(d.noiseReductionCheck, 'change', () => {
            this.persistCurrentSettings();
            this.#onStage1();
            this.#commitDspCommand('Noise reduction change');
        });
        on(d.claheCheck, 'pointerdown', () => this.#captureBeforeDsp());
        on(d.claheCheck, 'change', () => {
            this.persistCurrentSettings();
            this.#onStage1();
            this.#commitDspCommand('CLAHE change');
        });
    }

    /** Populate preset dropdown from built-ins + user presets. */
    populatePresetDropdown() {
        const sel = this.#d.presetSelect as HTMLSelectElement | null;
        if (!sel) return;
        sel.innerHTML = '';
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '— Custom —';
        sel.appendChild(empty);
        for (const name of Object.keys(DSP_PROFILES)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
            sel.appendChild(opt);
        }
        const userPresets = this.loadUserPresets();
        const userNames = Object.keys(userPresets);
        if (userNames.length) {
            const sep = document.createElement('option');
            sep.disabled = true;
            sep.textContent = '──────────';
            sel.appendChild(sep);
            const fav = this.getFavouritePreset();
            for (const name of userNames) {
                const opt = document.createElement('option');
                opt.value = `user:${name}`;
                opt.textContent = (fav === `user:${name}` ? '⭐ ' : '') + name;
                sel.appendChild(opt);
            }
        }
        const fav = this.getFavouritePreset();
        if (fav && Array.from(sel.options).some(o => o.value === fav)) {
            sel.value = fav;
        } else {
            sel.value = 'birder';
        }
    }

    /** Enable/disable and style the favourite button based on the current selection. */
    updatePresetButtons() {
        const val = this.#d.presetSelect?.value || '';
        const isAny = val !== '';
        const btn = this.#d.presetFavBtn;
        if (btn) {
            btn.disabled = !isAny;
            const isFav = isAny && this.getFavouritePreset() === val;
            btn.classList.toggle('active', isFav);
            btn.title = isFav ? 'Remove as default preset' : 'Set as default preset';
        }
    }

    /**
     * Apply a named preset (built-in or user): writes DOM controls, then calls
     * onRegenerateSpectrogram so the caller decides whether audio is available.
     */
    applyPreset(name: any) {
        const p = name.startsWith('user:')
            ? this.loadUserPresets()[name.slice(5)]
            : DSP_PROFILES[name];
        if (!p) return;
        this.#applyControls(p);
        if (this.#d.presetSelect) this.#d.presetSelect.value = name;
        this.updatePresetButtons();
        this.syncQualitySlider();
        this.updatePcenSectionDimming();
        this.#onRegen({ autoAdjust: true });
    }

    /**
     * Apply favourite preset or last-used settings to controls on init (no audio yet,
     * so does NOT call onRegenerateSpectrogram).
     */
    applyFavouritePresetControls() {
        const fav = this.getFavouritePreset();
        let p;
        if (fav) {
            p = fav.startsWith('user:')
                ? this.loadUserPresets()[fav.slice(5)]
                : DSP_PROFILES[fav];
        }
        if (!p) p = this.loadLastSettings();
        if (!p) {
            const defaultKey = this.#d.presetSelect?.value || 'birder';
            p = DSP_PROFILES[defaultKey];
        }
        if (!p) return;
        this.#applyControls(p);
        // Restore "Custom" label when last-used settings don't match a named preset
        if (!fav && !DSP_PROFILES[this.#d.presetSelect?.value || '']) {
            if (this.#d.presetSelect) this.#d.presetSelect.value = '';
        }
        this.updatePresetButtons();
    }

    /** Clear preset dropdown selection (set to Custom), persist settings. */
    clearPresetHighlight() {
        if (this.#d.presetSelect) this.#d.presetSelect.value = '';
        this.updatePresetButtons();
        this.persistCurrentSettings();
    }

    // ── Quality slider ───────────────────────────────────────────────

    applyQualityLevel(index: number) {
        const level = QUALITY_LEVELS[index as number];
        if (!level) return;
        const d = this.#d;
        if (d.windowSizeSelect)    d.windowSizeSelect.value    = String(level.windowSize);
        if (d.overlapSelect)       d.overlapSelect.value       = String(level.overlapLevel);
        if (d.oversamplingSelect)  d.oversamplingSelect.value  = String(level.oversamplingLevel);
        if (d.nMelsInput)          d.nMelsInput.value          = String(level.nMels);
        if (d.qualityLevelDisplay) d.qualityLevelDisplay.textContent = level.label;
        this.clearPresetHighlight();
        this.#onRegen();
    }

    syncQualitySlider() {
        const d = this.#d;
        if (!d.qualitySlider) return;
        const ws = parseInt(d.windowSizeSelect?.value   || '0',  10);
        const ol = parseInt(d.overlapSelect?.value      || '-1', 10);
        const os = parseInt(d.oversamplingSelect?.value || '-1', 10);
        const nm = parseInt(d.nMelsInput?.value         || '0',  10);
        const idx = QUALITY_LEVELS.findIndex(l =>
            l.windowSize === ws && l.overlapLevel === ol &&
            l.oversamplingLevel === os && l.nMels === nm,
        );
        if (idx >= 0) {
            d.qualitySlider.value = String(idx);
            if (d.qualityLevelDisplay) d.qualityLevelDisplay.textContent = QUALITY_LEVELS[idx].label;
        } else {
            if (d.qualityLevelDisplay) d.qualityLevelDisplay.textContent = 'Custom';
        }
    }

    // ── PCEN / colour-scale constraints ─────────────────────────────

    updatePcenSectionDimming() {
        const d = this.#d;
        if (!d.pcenSection) return;
        const enabled = d.pcenEnabledCheck?.checked ?? true;
        d.pcenSection.style.opacity = enabled ? '' : '0.45';
        for (const el of [d.pcenGainInput, d.pcenBiasInput, d.pcenRootInput, d.pcenSmoothingInput]) {
            if (el) el.disabled = !enabled;
        }
    }

    updateColourScaleConstraints() {
        const d = this.#d;
        const cs = d.colourScaleSelect?.value || 'dbSquared';
        if (d.pcenEnabledCheck) {
            if (cs === 'phase') {
                d.pcenEnabledCheck.checked  = false;
                d.pcenEnabledCheck.disabled = true;
            } else {
                d.pcenEnabledCheck.disabled = false;
            }
            this.updatePcenSectionDimming();
        }
    }

    // ── Settings snapshot / persistence ─────────────────────────────

    /** Snapshot current DSP controls into a preset-shape object. */
    getCurrentPresetSettings() {
        return readDspSettings(this.#d);
    }

    persistCurrentSettings() {
        jsonSetItem(this.#storage, LS_LAST_SETTINGS, this.getCurrentPresetSettings());
    }

    loadLastSettings(): Record<string, any> | null {
        const p = jsonGetItem<unknown>(this.#storage, LS_LAST_SETTINGS, null);
        if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, any>;
        return null;
    }

    loadUserPresets(): Record<string, any> {
        const p = jsonGetItem<unknown>(this.#storage, LS_USER_PRESETS, null);
        if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, any>;
        return {};
    }

    saveUserPresetsToStorage(presets: unknown) {
        jsonSetItem(this.#storage, LS_USER_PRESETS, presets);
    }

    getFavouritePreset() {
        return this.#storage.getItem(LS_FAV_PRESET) || '';
    }

    setFavouritePreset(key: any) {
        this.#storage.setItem(LS_FAV_PRESET, String(key));
    }

    dispose() {
        clearTimeout(this.#statusTimer);
    }

    // ─────────────────────────────────────────────────────────────────
    //  DSP undo helpers
    // ─────────────────────────────────────────────────────────────────

    /** Snapshot current DSP settings so we know what "before" was when the user changes something. */
    #captureBeforeDsp() {
        if (!this.#onDspCommand) return;       // undo not wired — skip
        if (!this.#dspBeforeSnapshot) {        // capture once; re-entrant calls are ignored
            this.#dspBeforeSnapshot = this.getCurrentPresetSettings();
        }
    }

    /**
     * Build and record a DspParamChange command after a control change.
     * Compares before/after snapshots; records nothing if settings are identical.
     * @param {string} description
     */
    #commitDspCommand(description: string) {
        if (!this.#onDspCommand || !this.#dspBeforeSnapshot) return;
        const before = this.#dspBeforeSnapshot;
        this.#dspBeforeSnapshot = null;
        const after = this.getCurrentPresetSettings();
        if (JSON.stringify(before) === JSON.stringify(after)) return;

        this.#onDspCommand?.({
            type: 'dsp-param',
            description,
            execute: () => {
                this.#applyControls(after);
                this.syncQualitySlider();
                this.updatePcenSectionDimming();
                this.updateColourScaleConstraints();
                this.persistCurrentSettings();
                this.#onRegen();
            },
            undo: () => {
                this.#applyControls(before);
                this.syncQualitySlider();
                this.updatePcenSectionDimming();
                this.updateColourScaleConstraints();
                this.persistCurrentSettings();
                this.#onRegen();
            },
        });
    }

    // ─────────────────────────────────────────────────────────────────
    //  Private helpers
    // ─────────────────────────────────────────────────────────────────

    /**
     * Write all DSP control DOM elements from a preset object.
     * Shared by applyPreset() and applyFavouritePresetControls().
     */
    #applyControls(p: any) {
        applyDspSettings(this.#d, p);
        if (p.colorScheme && this.#d.colorSchemeSelect) {
            this.#currentColorScheme = p.colorScheme;
        }
    }

    #showPresetStatus(msg: any, isError = false) {
        const el = this.#d.presetStatus;
        if (!el) return;
        el.textContent = msg;
        el.classList.toggle('pm-status-error', isError);
        el.classList.remove('pm-status-visible');
        void el.offsetWidth; // force reflow for animation
        el.classList.add('pm-status-visible');
        clearTimeout(this.#statusTimer);
        this.#statusTimer = setTimeout(() => el.classList.remove('pm-status-visible'), 2500);
    }

    #openPresetManager() {
        const d = this.#d;
        if (!d.presetManagerPanel) return;
        const isOpen = !d.presetManagerPanel.hidden;
        d.presetManagerPanel.hidden = isOpen;
        d.presetManageBtn?.classList.toggle('active', !isOpen);
        if (!isOpen) this.#renderPresetManagerList();
    }

    #closePresetManager() {
        if (this.#d.presetManagerPanel) this.#d.presetManagerPanel.hidden = true;
        this.#d.presetManageBtn?.classList.remove('active');
    }

    #renderPresetManagerList() {
        const list = this.#d.presetManagerList;
        if (!list) return;
        list.innerHTML = '';
        const fav = this.getFavouritePreset();

        const starSvg       = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
        const starFilledSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
        const trashSvg      = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
        const pencilSvg     = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 00-3.986-3.987L3.842 16.174a2 2 0 00-.5.83l-1.321 4.352a.5.5 0 00.62.62l4.352-1.321a2 2 0 00.83-.497z"/></svg>`;

        // Built-in presets
        for (const name of Object.keys(DSP_PROFILES)) {
            const key   = name;
            const isFav = fav === key;
            const row   = document.createElement('div');
            row.className = 'pm-item';
            row.innerHTML = `
                <button class="pm-fav-btn${isFav ? ' active' : ''}" title="Set as default">${isFav ? starFilledSvg : starSvg}</button>
                <span class="pm-name" title="Click to apply">${name.charAt(0).toUpperCase() + name.slice(1)}</span>
                <span class="pm-badge">built-in</span>`;
            const favBtn = row.querySelector('.pm-fav-btn');
            if (favBtn) {
                const favEl = /** @type {HTMLElement} */ (favBtn);
                favEl.addEventListener('click', () => {
                    this.setFavouritePreset(isFav ? '' : key);
                    this.populatePresetDropdown();
                    this.updatePresetButtons();
                    this.#renderPresetManagerList();
                });
            }
            const nameEl = row.querySelector('.pm-name');
            if (nameEl) {
                const nameHTMLElement = /** @type {HTMLElement} */ (nameEl);
                nameHTMLElement.addEventListener('click', () => {
                    this.applyPreset(key);
                    this.persistCurrentSettings();
                });
            }
            list.appendChild(row);
        }

        // User presets
        const userPresets = this.loadUserPresets();
        for (const name of Object.keys(userPresets)) {
            const key   = `user:${name}`;
            const isFav = fav === key;
            const row   = document.createElement('div');
            row.className = 'pm-item';
            row.innerHTML = `
                <button class="pm-fav-btn${isFav ? ' active' : ''}" title="Set as default">${isFav ? starFilledSvg : starSvg}</button>
                <span class="pm-name" title="Click to apply"></span>
                <button class="pm-icon-btn pm-rename-btn" title="Rename">${pencilSvg}</button>
                <button class="pm-icon-btn pm-delete-btn" title="Delete">${trashSvg}</button>`;
            const nameSpan = row.querySelector('.pm-name');
            if (nameSpan) (/** @type {HTMLElement} */ (nameSpan)).textContent = name;

            const favBtnUser = row.querySelector('.pm-fav-btn');
            if (favBtnUser) {
                const favUserEl = /** @type {HTMLElement} */ (favBtnUser);
                favUserEl.addEventListener('click', () => {
                    this.setFavouritePreset(isFav ? '' : key);
                    this.populatePresetDropdown();
                    this.updatePresetButtons();
                    this.#renderPresetManagerList();
                });
            }

            const nameBtnUser = row.querySelector('.pm-name');
            if (nameBtnUser) {
                const nameUserEl = /** @type {HTMLElement} */ (nameBtnUser);
                nameUserEl.addEventListener('click', () => {
                    this.applyPreset(key);
                    this.persistCurrentSettings();
                });
            }

            const renameBtn = row.querySelector('.pm-rename-btn');
            if (renameBtn) {
                const renameEl = /** @type {HTMLElement} */ (renameBtn);
                renameEl.addEventListener('click', () => this.#inlineRenamePreset(name, row));
            }

            const delBtn = row.querySelector('.pm-delete-btn');
            if (delBtn) {
                const db = /** @type {HTMLElement} */ (delBtn);
                db.addEventListener('click', () => {
                            if (db.classList.contains('pm-confirm-delete')) {
                                this.#deleteUserPreset(name);
                            } else {
                                db.classList.add('pm-confirm-delete');
                                (db as HTMLElement).title = 'Click again to confirm';
                                setTimeout(() => { db.classList.remove('pm-confirm-delete'); (db as HTMLElement).title = 'Delete'; }, 2000);
                            }
                });
            }
            list.appendChild(row);
        }

        if (!Object.keys(DSP_PROFILES).length && !Object.keys(userPresets).length) {
            const empty = document.createElement('div');
            empty.className = 'pm-empty';
            empty.textContent = 'No presets yet.';
            list.appendChild(empty);
        }
    }

    #promptSaveUserPreset() {
        const d = this.#d;
        if (!d.presetSaveRow) return;
        const isOpen = !d.presetSaveRow.hidden;
        d.presetSaveRow.hidden = isOpen;
        if (!isOpen && d.presetSaveInput) { d.presetSaveInput.value = ''; d.presetSaveInput.focus(); }
    }

    #confirmSaveUserPreset() {
        const d = this.#d;
        const inp = d.presetSaveInput;
        if (!inp) return;
        const clean = (inp.value || '').trim();
        if (!clean) return;
        if (DSP_PROFILES[clean.toLowerCase()]) {
            this.#showPresetStatus('Built-in name — choose another', true);
            return;
        }
        const presets = this.loadUserPresets();
        presets[clean] = this.getCurrentPresetSettings();
        this.saveUserPresetsToStorage(presets);
        this.populatePresetDropdown();
        if (d.presetSelect) d.presetSelect.value = `user:${clean}`;
        this.updatePresetButtons();
        d.presetSaveRow.hidden = true;
        this.#renderPresetManagerList();
        this.#showPresetStatus(`Saved "${clean}"`);
    }

    #cancelSaveUserPreset() {
        if (this.#d.presetSaveRow) this.#d.presetSaveRow.hidden = true;
    }

    #toggleFavouritePreset() {
        const val = this.#d.presetSelect?.value || '';
        if (!val) return;
        const current = this.getFavouritePreset();
        this.setFavouritePreset(current === val ? '' : val);
        this.populatePresetDropdown();
        if (this.#d.presetSelect) this.#d.presetSelect.value = val;
        this.updatePresetButtons();
        this.#renderPresetManagerList();
    }

    #inlineRenamePreset(oldName: any, row: any) {
        const nameSpan = (row as HTMLElement).querySelector('.pm-name');
        if (!nameSpan || row.querySelector('.pm-rename-input')) return;
        const input = document.createElement('input');
        input.type      = 'text';
        input.className = 'pm-rename-input';
        input.value     = oldName;
        input.maxLength = 40;
        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
            const clean = (input.value || '').trim();
            if (!clean || clean === oldName) { this.#renderPresetManagerList(); return; }
            if (DSP_PROFILES[clean.toLowerCase()]) {
                this.#showPresetStatus('Built-in name — choose another', true);
                this.#renderPresetManagerList();
                return;
            }
            const presets = this.loadUserPresets();
            if (presets[clean]) {
                this.#showPresetStatus(`"${clean}" already exists`, true);
                this.#renderPresetManagerList();
                return;
            }
            presets[clean] = presets[oldName];
            delete presets[oldName];
            this.saveUserPresetsToStorage(presets);
            const oldKey = `user:${oldName}`;
            const newKey = `user:${clean}`;
            if (this.getFavouritePreset() === oldKey) this.setFavouritePreset(newKey);
            this.populatePresetDropdown();
            this.updatePresetButtons();
            this.#renderPresetManagerList();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')  commit();
            if (e.key === 'Escape') this.#renderPresetManagerList();
        });
        input.addEventListener('blur', commit);
    }

    #deleteUserPreset(name: any) {
        const presets = this.loadUserPresets();
        delete presets[name];
        this.saveUserPresetsToStorage(presets);
        const key = `user:${name}`;
        if (this.getFavouritePreset() === key) this.setFavouritePreset('');
        this.populatePresetDropdown();
        this.updatePresetButtons();
        this.#renderPresetManagerList();
    }

    #exportPresets() {
        const data = {
            version: 1,
            favourite: this.getFavouritePreset(),
            presets: this.loadUserPresets(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'signavis-presets.json';
        a.click();
        URL.revokeObjectURL(url);
        this.#showPresetStatus('Exported');
    }

    #importPresets() {
        const input    = document.createElement('input');
        input.type     = 'file';
        input.accept   = '.json,application/json';
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(String(reader.result));
                    if (!data || typeof data !== 'object' || typeof data.presets !== 'object' || Array.isArray(data.presets)) {
                        this.#showPresetStatus('Invalid preset file', true); return;
                    }
                    for (const [k, v] of Object.entries(data.presets)) {
                        if (!v || typeof v !== 'object' || Array.isArray(v)) {
                            this.#showPresetStatus(`Invalid entry: "${k}"`, true); return;
                        }
                    }
                    const existing = this.loadUserPresets();
                    let imported   = 0;
                    for (const [k, v] of Object.entries(data.presets)) {
                        if (DSP_PROFILES[k.toLowerCase()]) continue;
                        existing[k] = v;
                        imported++;
                    }
                    this.saveUserPresetsToStorage(existing);
                    if (typeof data.favourite === 'string' && data.favourite.startsWith('user:')) {
                        const favName = data.favourite.slice(5);
                        if (existing[favName]) this.setFavouritePreset(data.favourite);
                    }
                    this.populatePresetDropdown();
                    this.updatePresetButtons();
                    this.#renderPresetManagerList();
                    this.#showPresetStatus(`Imported ${imported} preset(s)`);
                } catch {
                    this.#showPresetStatus('Failed to parse file', true);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }
}
