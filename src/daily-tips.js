import ModalManager from './modal-manager.js';

const DEFAULT_TIPS = [
  {
    title: 'Quick labeling shortcuts',
    text: 'Draw regions with Shift + Drag, move with Drag or press G, double‑click to edit; press Esc to close editors. Delete with X, Del, or Backspace.'
  },
  {
    title: 'Playback & seeking',
    text: 'Space: Play / Pause. J / L: seek -5s / +5s for fast navigation between sections.'
  },
  {
    title: 'Zoom controls',
    text: 'Ctrl / Cmd + Scroll to zoom horizontally; Shift + Scroll to zoom vertically. Use pinch gestures on touch.'
  },
  {
    title: 'Copy, paste & undo',
    text: 'Ctrl / Cmd + C / V to copy & paste labels; Ctrl / Cmd + Z to undo, Ctrl / Cmd + Y to redo.'
  },
  {
    title: 'Tags & metadata',
    text: 'Add Sex, Life stage and Sound type tags to improve searchability and export quality.'
  },
];

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _createButton(text, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  return b;
}

/**
 * Render a tip into a modal and return the ModalManager instance.
 *
 * @param {Object} tip
 * @param {HTMLElement} [host]
 * @param {Object} [opts]
 * @param {number} [opts.index]
 * @param {number} [opts.count]
 * @param {() => void} [opts.onNext]
 * @param {() => void} [opts.onPrev]
 * @param {() => void} [opts.onClose]
 * @param {(disabled: boolean) => void} [opts.onDisable]
 * @returns {import('./modal-manager.js').default}
 */
export function showTip(tip, host = document.body, { index = 0, count = 1, onNext, onPrev, onClose, onDisable } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'label-editor-backdrop daily-tip-backdrop';

  const dialog = document.createElement('div');
  dialog.className = 'daily-tip-dialog';

  const header = document.createElement('div');
  header.className = 'daily-tip-header';
  const h = document.createElement('h3');
  h.className = 'modal-title';
  h.textContent = tip.title || 'Tip';
  header.appendChild(h);
  // add a small counter (e.g. "Tip 1 of 3")
  const counter = document.createElement('div');
  counter.className = 'daily-tip-counter';
  try { counter.textContent = `Tip ${Number(index) + 1} of ${Number(count) || 1}`; } catch (e) { counter.textContent = ''; }
  header.appendChild(counter);

  const body = document.createElement('div');
  body.className = 'daily-tip-body';
  body.textContent = tip.text || '';

  const actions = document.createElement('div');
  actions.className = 'daily-tip-actions';

  const prevBtn = _createButton('Previous Tip', 'daily-tip-prev');
  const nextBtn = _createButton('Next Tip', 'daily-tip-next');
  // 'modal-close' ensures ModalManager finds this button and doesn't inject a
  // duplicate ×-button at the top-right corner of the dialog.
  const closeBtn = _createButton('Close', 'daily-tip-close modal-close');

  // Disable checkbox (persistent preference)
  const disableId = `daily-tip-disable-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  const disableLabel = document.createElement('label');
  disableLabel.className = 'daily-tip-disable-label';
  const disableCheckbox = document.createElement('input');
  disableCheckbox.type = 'checkbox';
  disableCheckbox.className = 'daily-tip-disable-checkbox';
  disableCheckbox.id = disableId;
  try { disableCheckbox.checked = localStorage.getItem('audio-workbench.daily-tips.disabled') === '1'; } catch (e) { /* ignore */ }
  disableLabel.appendChild(disableCheckbox);
  disableLabel.appendChild(document.createTextNode(" Don't show again"));

  // actions layout: left (checkbox) and right (buttons)
  const actionsLeft = document.createElement('div');
  actionsLeft.className = 'daily-tip-actions-left';
  actionsLeft.appendChild(disableLabel);

  const actionsRight = document.createElement('div');
  actionsRight.className = 'daily-tip-actions-right';
  actionsRight.append(prevBtn, nextBtn, closeBtn);

  actions.append(actionsLeft, actionsRight);

  dialog.append(header, body, actions);
  backdrop.appendChild(dialog);
  host.appendChild(backdrop);

  const modal = new ModalManager({ backdrop, dialog });

  // cleanup helper removes DOM and disposes modal handlers
  const cleanup = () => {
    try { modal.dispose(); } catch (e) { /* ignore */ }
    try { backdrop.parentNode && backdrop.parentNode.removeChild(backdrop); } catch (e) { /* ignore */ }
  };

  // wrap close so we can cleanup and notify
  const origClose = modal.close.bind(modal);
  modal.close = () => {
    try { origClose(); } catch (e) { /* ignore */ }
    try { cleanup(); } catch (e) { /* ignore */ }
    try { onClose && onClose(); } catch (e) { /* ignore */ }
  };

  nextBtn.addEventListener('click', () => {
    try { origClose(); } catch (e) { /* ignore */ }
    try { cleanup(); } catch (e) { /* ignore */ }
    try { onNext && onNext(); } catch (e) { /* ignore */ }
  });

  prevBtn.addEventListener('click', () => {
    try { origClose(); } catch (e) { /* ignore */ }
    try { cleanup(); } catch (e) { /* ignore */ }
    try { onPrev && onPrev(); } catch (e) { /* ignore */ }
  });

  // Mark as bound so ModalManager doesn't add a second handler on open().
  closeBtn.dataset.modalHandlerBound = '1';
  closeBtn.addEventListener('click', () => modal.close());

  disableCheckbox.addEventListener('change', () => {
    try { localStorage.setItem('audio-workbench.daily-tips.disabled', disableCheckbox.checked ? '1' : '0'); } catch (e) { /* ignore */ }
    try { onDisable && onDisable(disableCheckbox.checked); } catch (e) { /* ignore */ }
  });

  modal.open();
  return modal;
}

/**
 * Initialize daily tips: shows one tip per day unless disabled.
 * Call with `{ force: true }` to show immediately regardless of last shown date.
 */
export function initDailyTips({ host = document.body, tips = DEFAULT_TIPS, storagePrefix = 'audio-workbench.daily-tips', force = false } = {}) {
  try {
    const disabled = localStorage.getItem(`${storagePrefix}.disabled`) === '1';
    if (disabled && !force) return;
    const today = _today();
    const last = localStorage.getItem(`${storagePrefix}.lastDate`);
    if (!force && last === today) return;

    // If a daily-tip modal is already present in the host, focus it and avoid
    // creating another one. This prevents stacking when the Help button is
    // clicked multiple times quickly.
    try {
      const existing = host && host.querySelector && host.querySelector('.daily-tip-backdrop');
        if (existing) {
          try {
            const dlg = existing.querySelector('.daily-tip-dialog');
            const focusTarget = dlg && (dlg.querySelector('button, [tabindex], input') || dlg);
            if (focusTarget instanceof HTMLElement) focusTarget.focus();
          } catch (e) { /* ignore */ }
          return;
        }
    } catch (e) { /* ignore */ }

    let index = parseInt(localStorage.getItem(`${storagePrefix}.index`) || '0', 10) || 0;

    const showAt = (idx) => {
      const tip = tips[idx % tips.length];
      showTip(tip, host, {
        index: idx,
        count: tips.length,
        onNext() {
          index = (idx + 1) % tips.length;
          try { localStorage.setItem(`${storagePrefix}.index`, String(index)); } catch (e) { /* ignore */ }
          showAt(index);
        },
        onPrev() {
          index = (idx - 1 + tips.length) % tips.length;
          try { localStorage.setItem(`${storagePrefix}.index`, String(index)); } catch (e) { /* ignore */ }
          showAt(index);
        },
        onClose() {
          try { localStorage.setItem(`${storagePrefix}.lastDate`, today); } catch (e) { /* ignore */ }
        },
        onDisable(disabled) {
          try { localStorage.setItem(`${storagePrefix}.disabled`, disabled ? '1' : '0'); } catch (e) { /* ignore */ }
        }
      });
    };

    showAt(index);
  } catch (e) {
    // fail silently in environments without localStorage
    try { showTip(tips[0], host); } catch (e) { /* ignore */ }
  }
}

export default { initDailyTips, showTip };
