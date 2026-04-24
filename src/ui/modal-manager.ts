/**
 * ModalManager — backdrop + focus trap + keyboard handling for dialogs.
 *
 * Close lifecycle
 * ───────────────
 * External code should call `modal.close()` for programmatic close (e.g. a
 * "Save" button that dismisses and processes data).
 *
 * For Escape / backdrop-click / injected ×-button the manager first invokes
 * `options.onClose` if provided, giving the host a chance to run its own
 * cleanup (e.g. remove the backdrop from the DOM, dispose).  If no `onClose`
 * is supplied the manager falls back to calling `this.close()` itself.
 *
 * This means the host's `close` function can safely call `modal.close()` as
 * part of cleanup without creating a circular call: `ModalManager.close()`
 * only hides + unbinds, it never calls `onClose`.
 */

/**
 * @typedef {Object} ModalManagerOptions
 * @property {HTMLElement|null|undefined} [backdrop]
 * @property {HTMLElement|null|undefined} [dialog]
 * @property {(() => void)|null|undefined} [onClose]
 */
export default class ModalManager {
  /**
   * @param {ModalManagerOptions} [opts]
   */
  constructor({ backdrop = null, dialog = null, onClose = null } = {}) {
    /** @type {HTMLElement|null} */
    this.backdrop = backdrop || null;
    /** @type {HTMLElement|null} */
    this.dialog = dialog || (this.backdrop && this.backdrop.querySelector('.modal, .xc-nokey-dialog, [role="dialog"], dialog')) || null;
    /** @type {(() => void)|null} Called instead of close() for user-initiated dismiss (Escape, backdrop, ×) */
    this._onClose = onClose || null;

    this._onKeydown = this._onKeydown.bind(this);
    this._onBackdropClick = this._onBackdropClick.bind(this);
    this._onCloseClick = this._onCloseClick.bind(this);
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

      /** @type {HTMLButtonElement|null} */
      let btn = /** @type {HTMLButtonElement|null} */ (this.dialog.querySelector('.modal-close'));
      if (!btn) {
        // Inject a close button if the dialog doesn't already have one
        const newBtn = /** @type {HTMLButtonElement} */ (document.createElement('button'));
        newBtn.type = 'button';
        newBtn.className = 'modal-close modal-close--injected';
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
      const focusTarget = this._getFocusable()[0] || this.dialog || this.backdrop;
      try { if (focusTarget instanceof HTMLElement) focusTarget.focus(); } catch (e) { /* ignore */ }
    }, 0);
  }

  /** Hide + unbind. Does NOT call onClose. */
  close() {
    if (this.backdrop) {
      this.backdrop.classList.remove('show');
      this.backdrop.setAttribute('aria-hidden', 'true');
      try { this.backdrop.hidden = true; } catch (e) { /* ignore */ }
    }
    this._unbind();
    setTimeout(() => { try { if (this._lastActive instanceof HTMLElement) this._lastActive.focus(); } catch (e) { /* ignore */ } }, 0);
  }

  dispose() {
    this._unbind();
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

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Central dismiss handler: called by Escape, backdrop click, and the ×
   * button.  Delegates to `onClose` if supplied, otherwise closes directly.
   */
  _handleCloseRequest() {
    if (this._onClose) {
      this._onClose();
    } else {
      this.close();
    }
  }

  _bind() {
    document.addEventListener('keydown', this._onKeydown);
    this.backdrop?.addEventListener('pointerdown', this._onBackdropClick);
  }

  _unbind() {
    document.removeEventListener('keydown', this._onKeydown);
    this.backdrop?.removeEventListener('pointerdown', this._onBackdropClick);
  }

  _onKeydown(e: unknown) {
    if (e.key === 'Escape' && this.backdrop?.classList.contains('show')) {
      e.preventDefault();
      this._handleCloseRequest();
      return;
    }
    if (e.key === 'Tab' && this.backdrop?.classList.contains('show')) {
      this._trapTab(e);
    }
  }

  _onBackdropClick(e: unknown) {
    if (e.target === this.backdrop) this._handleCloseRequest();
  }

  _onCloseClick() {
    this._handleCloseRequest();
  }

  _getFocusable() {
    const root = this.dialog || this.backdrop || document.body;
    const nodes = root.querySelectorAll('a[href], area[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex]:not([tabindex="-1"]), [contenteditable]');
    return Array.prototype.slice.call(nodes).filter(n => n.offsetWidth || n.offsetHeight || n.getClientRects().length);
  }

  _trapTab(e: unknown) {
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

  _generateId(prefix = 'id') {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
