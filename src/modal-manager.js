/**
 * Simple ModalManager for src code
 * - toggles backdrop visibility
 * - ensures basic ARIA attributes on dialog
 * - traps focus inside the dialog while open
 * - restores focus and removes listeners on close / dispose
 */
/**
 * @typedef {Object} ModalManagerOptions
 * @property {HTMLElement|null|undefined} [backdrop]
 * @property {HTMLElement|null|undefined} [dialog]
 */
export default class ModalManager {
  /**
   * @param {ModalManagerOptions} [opts]
   */
  constructor({ backdrop = null, dialog = null } = {}) {
    /** @type {HTMLElement|null} */
    this.backdrop = backdrop || null;
    /** @type {HTMLElement|null} */
    this.dialog = dialog || (this.backdrop && (this.backdrop.querySelector('.modal, .xc-nokey-dialog, [role="dialog"], dialog'))) || null;
    this._onKeydown = this._onKeydown.bind(this);
    this._onBackdropClick = this._onBackdropClick.bind(this);
    this._onCloseClick = this._onCloseClick?.bind(this);
    this._lastActive = null;
    this._closeBtn = null;
  }

  open() {
    this._lastActive = document.activeElement;
    if (this.backdrop) {
      try { this.backdrop.hidden = false; } catch (e) { /* ignore */ }
      this.backdrop.classList.add('show');
      this.backdrop.setAttribute('aria-hidden', 'false');
    }
    if (this.dialog) {
      if (!this.dialog.getAttribute('role')) this.dialog.setAttribute('role', 'dialog');
      this.dialog.setAttribute('aria-modal', 'true');
      const title = this.dialog.querySelector('.modal-title, h1, h2, h3, .title');
      if (title && !title.id) title.id = this._generateId('modal-title');
      if (title) this.dialog.setAttribute('aria-labelledby', title.id);
      // Ensure an accessible close button exists in the dialog
      /** @type {HTMLButtonElement|null} */
      let btn = /** @type {HTMLButtonElement|null} */ (this.dialog.querySelector('.modal-close'));
      if (!btn) {
        const newBtn = /** @type {HTMLButtonElement} */ (document.createElement('button'));
        newBtn.type = 'button';
        newBtn.className = 'modal-close';
        newBtn.setAttribute('aria-label', 'Close');
        newBtn.textContent = '\u00d7';
        newBtn.dataset.modalManaged = '1';
        this.dialog.appendChild(newBtn);
        this._closeBtn = newBtn;
        newBtn.addEventListener('click', this._onCloseClick);
      } else {
        this._closeBtn = btn;
        if (!btn.dataset.modalHandlerBound) {
          btn.addEventListener('click', this._onCloseClick);
          btn.dataset.modalHandlerBound = '1';
        }
      }
    }
    this._bind();
    setTimeout(() => {
      const focusTarget = (this._getFocusable()[0]) || this.dialog || this.backdrop;
      try { if (focusTarget instanceof HTMLElement) focusTarget.focus(); } catch (e) { /* ignore */ }
    }, 0);
  }

  close() {
    if (this.backdrop) {
      this.backdrop.classList.remove('show');
      this.backdrop.setAttribute('aria-hidden', 'true');
      try { this.backdrop.hidden = true; } catch (e) { /* ignore */ }
    }
    this._unbind();
    setTimeout(() => { try { if (this._lastActive instanceof HTMLElement) this._lastActive.focus(); } catch (e) { /* ignore */ } }, 0);
  }

  _bind() {
    document.addEventListener('keydown', this._onKeydown);
    // Use pointerdown to reliably catch outside clicks even when other
    // handlers may stop/capture click events earlier.
    this.backdrop?.addEventListener('pointerdown', this._onBackdropClick);
  }

  _unbind() {
    document.removeEventListener('keydown', this._onKeydown);
    this.backdrop?.removeEventListener('pointerdown', this._onBackdropClick);
  }

  _onKeydown(e) {
    if (e.key === 'Escape' && this.backdrop?.classList.contains('show')) {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === 'Tab' && this.backdrop?.classList.contains('show')) {
      this._trapTab(e);
    }
  }

  _onBackdropClick(e) {
    if (e.target === this.backdrop) this.close();
  }

  _onCloseClick() {
    this.close();
  }

  _getFocusable() {
    const root = this.dialog || this.backdrop || document.body;
    const nodes = root.querySelectorAll('a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex]:not([tabindex="-1"]), [contenteditable]');
    return Array.prototype.slice.call(nodes).filter(n => n.offsetWidth || n.offsetHeight || n.getClientRects().length);
  }

  _trapTab(e) {
    const focusable = this._getFocusable();
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  dispose() {
    this._unbind();
    // remove managed close button if we created it, otherwise remove handler
    if (this._closeBtn) {
      try {
        if (this._closeBtn.dataset.modalManaged === '1') {
          this._closeBtn.removeEventListener('click', this._onCloseClick);
          this._closeBtn.parentNode && this._closeBtn.parentNode.removeChild(this._closeBtn);
        } else {
          this._closeBtn.removeEventListener('click', this._onCloseClick);
        }
      } catch (e) { /* ignore */ }
    }
    this._closeBtn = null;
    this.backdrop = null;
    this.dialog = null;
  }

  _generateId(prefix = 'id') {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
