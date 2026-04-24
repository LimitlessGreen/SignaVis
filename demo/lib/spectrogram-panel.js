/**
 * Spectrogram settings sidebar panel.
 *
 * Relocates the player's internal settings-panel sections into a sidebar
 * panel element. All existing PlayerState event handlers keep working
 * because they reference DOM nodes directly (via `this.d`), not their
 * position in the DOM tree.
 */

export class SpectrogramSettingsPanel {
  /**
   * @param {import('../../src/app/BirdNETPlayer.ts').BirdNETPlayer} player
   */
  constructor(player) {
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
  }
}
