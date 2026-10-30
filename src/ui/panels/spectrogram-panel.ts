/**
 * Spectrogram settings sidebar panel.
 *
 * Relocates the player's internal settings-panel sections into a sidebar
 * panel element. All existing PlayerState event handlers keep working
 * because they reference DOM nodes directly (via `this.d`), not their
 * position in the DOM tree.
 *
 * Expert mode: controls marked `data-expert` in the player template are
 * hidden by default. Hidden settings stay in effect, so the panel shows a
 * hint when they differ from the active preset, with a one-click reset.
 */

import { readDspSettings } from '../../domain/dsp/DspSettings.ts';

const EXPERT_MODE_KEY = 'signavis.spectrogram-expert-mode';

/** DSP settings that only expert mode exposes (window size/overlap/oversampling/mel bins follow the quality slider). */
const EXPERT_KEYS = [
  'scale', 'colourScale', 'windowFunction', 'reassigned', 'clahe',
  'usePcen', 'pcenGain', 'pcenBias', 'pcenRoot', 'pcenTimeConstant',
];

/** Overlay checkboxes (not part of presets): any one switched on counts as a deviation. */
const OVERLAY_CHECKS = ['showCentroidCheck', 'showF0Check', 'showRidgesCheck'];

export class SpectrogramSettingsPanel {
    // TypeScript property declarations (migrated from JS)
    _player: any;
    el: any;
    _relocated: any;
    _expertCheck: HTMLInputElement | null = null;
    _hint: HTMLElement | null = null;
  /**
   * @param {import('../../src/app/BirdNETPlayer.ts').BirdNETPlayer} player
   */
  constructor(player: any) {
    /** @type {HTMLElement} */
    this.el = document.createElement('div');
    this.el.className = 'scroll-panel spectrogram-settings-panel';
    this._player = player;
    this._relocated = false;
  }

  /**
   * Relocate the player's internal settings sections into this panel.
   * Call after the player is fully constructed (after `await player.ready`).
   */
  relocate() {
    if (this._relocated) return;
    const root = this._player._state?.container;
    if (!root) return;

    const internalPanel = root.querySelector('.settings-panel');
    if (!internalPanel) return;

    // Move all .settings-section elements into our panel element
    const sections = internalPanel.querySelectorAll('.settings-section, .quality-slider-section');
    for (const section of sections) {
      this.el.appendChild(section);
    }

    // Hide the internal settings panel and its toggle button
    internalPanel.style.display = 'none';
    const toggleBtn = root.querySelector('[data-aw="settingsToggleBtn"]');
    if (toggleBtn) toggleBtn.style.display = 'none';

    this._relocated = true;
    this._buildExpertToggle();
  }

  get expertMode(): boolean {
    return this.el.classList.contains('expert-mode');
  }

  setExpertMode(on: boolean) {
    this.el.classList.toggle('expert-mode', on);
    if (this._expertCheck) this._expertCheck.checked = on;
    try { localStorage.setItem(EXPERT_MODE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    this._updateHint();
  }

  _buildExpertToggle() {
    const sec = document.createElement('div');
    sec.className = 'settings-section expert-mode-section';
    sec.innerHTML = `
      <label class="field-check" title="Show all DSP parameters: frequency scale, window function, PCEN, overlays …">
        <input type="checkbox" /> Expert mode
      </label>
      <div class="expert-hint" hidden>
        <span></span>
        <button type="button" class="toolbar-btn mini-btn" title="Reset hidden expert settings to the active preset">Reset</button>
      </div>`;
    this._expertCheck = sec.querySelector('input');
    this._hint = sec.querySelector('.expert-hint');
    this._expertCheck!.addEventListener('change', () => this.setExpertMode(this._expertCheck!.checked));
    this._hint!.querySelector('button')!.addEventListener('click', () => this._resetExpertSettings());

    // Place it after the preset section, so presets stay the first thing users see
    const preset = this.el.querySelector('.preset-section');
    this.el.insertBefore(sec, preset ? preset.nextSibling : this.el.firstChild);

    // Every control change bubbles up to the panel; preset changes rewrite controls synchronously
    this.el.addEventListener('change', () => this._updateHint());

    let on = false;
    try { on = localStorage.getItem(EXPERT_MODE_KEY) === '1'; } catch { /* ignore */ }
    this.setExpertMode(on);
  }

  /** Names of hidden settings that differ from the active preset (plus active overlays). */
  _deviations(): string[] {
    const state = this._player._state;
    if (!state?.d || !state._presets) return [];
    const cur: Record<string, any> = readDspSettings(state.d);
    const ref = state._presets.getReferenceSettings();
    const out = EXPERT_KEYS.filter((k) => cur[k] !== ref[k]);
    for (const k of OVERLAY_CHECKS) if (state.d[k]?.checked) out.push(k);
    return out;
  }

  _updateHint() {
    if (!this._hint) return;
    const n = this.expertMode ? 0 : this._deviations().length;
    this._hint.hidden = n === 0;
    if (n) {
      this._hint.querySelector('span')!.textContent =
        `${n} hidden expert setting${n === 1 ? '' : 's'} differ${n === 1 ? 's' : ''} from the preset.`;
    }
  }

  _resetExpertSettings() {
    const state = this._player._state;
    if (!state?._presets) return;
    const dev = this._deviations();
    const keys = dev.filter((k) => EXPERT_KEYS.includes(k));
    if (keys.length) state._presets.resetToReference(keys);
    for (const k of dev) {
      const check = state.d[k];
      if (OVERLAY_CHECKS.includes(k) && check) {
        check.checked = false;
        check.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    this._updateHint();
  }
}
