/**
 * Lightweight reusable context menu.
 *
 * Usage:
 *   import { showContextMenu } from './lib/context-menu.js';
 *
 *   element.addEventListener('contextmenu', (e) => {
 *     e.preventDefault();
 *     showContextMenu({
 *       x: e.clientX, y: e.clientY,
 *       items: [
 *         { label: 'Rename', icon: '<svg…/>', action: () => doRename() },
 *         { separator: true },
 *         { label: 'Delete', icon: '<svg…/>', action: () => doDelete(), danger: true },
 *       ],
 *     });
 *   });
 *
 * Only one menu is open at a time — calling showContextMenu() while another
 * is open closes the previous one first.
 */

/**
 * @typedef {object} ContextMenuItem
 * @property {string}      [label]     Display text.
 * @property {string}      [icon]      SVG string (optional).
 * @property {() => void}  [action]    Called when the item is activated.
 * @property {boolean}     [danger]    Red/destructive styling.
 * @property {boolean}     [disabled]  Greyed out, not interactive.
 * @property {boolean}     [separator] Renders a divider line instead of an item.
 */

let _current = null;

/**
 * Show a context menu at the given viewport coordinates.
 *
 * @param {{ x: number, y: number, items: ContextMenuItem[] }} opts
 */
export function showContextMenu({ x, y, items }) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');

  /** @type {HTMLElement[]} — focusable (non-separator, non-disabled) items */
  const focusable = [];
  let activeIdx = -1;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }

    const row = document.createElement('button');
    row.className = 'ctx-item' + (item.danger ? ' ctx-item--danger' : '');
    row.setAttribute('role', 'menuitem');
    row.type = 'button';
    if (item.disabled) {
      row.disabled = true;
      row.classList.add('ctx-item--disabled');
    }

    if (item.icon) {
      const iconWrap = document.createElement('span');
      iconWrap.className = 'ctx-item-icon';
      iconWrap.innerHTML = item.icon;
      row.appendChild(iconWrap);
    }

    const labelEl = document.createElement('span');
    labelEl.className = 'ctx-item-label';
    labelEl.textContent = item.label ?? '';
    row.appendChild(labelEl);

    if (!item.disabled) {
      row.addEventListener('click', () => {
        closeContextMenu();
        item.action?.();
      });
      focusable.push(row);
    }

    menu.appendChild(row);
  }

  // ── Position: clamp to viewport ──────────────────────────────────────────
  document.body.appendChild(menu);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  let left = x;
  let top  = y;
  if (left + mw > vw - 4) left = Math.max(4, vw - mw - 4);
  if (top  + mh > vh - 4) top  = Math.max(4, vh - mh - 4);

  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;

  // Trigger CSS open animation on next frame
  requestAnimationFrame(() => menu.classList.add('ctx-menu--open'));

  // ── Keyboard navigation ──────────────────────────────────────────────────
  function navigate(dir) {
    activeIdx = Math.max(0, Math.min(focusable.length - 1, activeIdx + dir));
    focusable.forEach((r, i) => r.classList.toggle('ctx-item--active', i === activeIdx));
    focusable[activeIdx]?.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === 'Escape')     { e.stopPropagation(); closeContextMenu(); }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); navigate(activeIdx < 0 ? 0 : 1); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); navigate(activeIdx < 0 ? -1 : -1); }
    else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      focusable[activeIdx]?.click();
    }
  }

  // ── Auto-close ───────────────────────────────────────────────────────────
  function onPointerDown(e) {
    if (!menu.contains(e.target)) closeContextMenu();
  }

  document.addEventListener('keydown',     onKey,        { capture: true });
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  window  .addEventListener('blur',        closeContextMenu);
  window  .addEventListener('scroll',      closeContextMenu, { once: true, capture: true });

  _current = {
    el: menu,
    cleanup() {
      document.removeEventListener('keydown',     onKey,        { capture: true });
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window  .removeEventListener('blur',        closeContextMenu);
      window  .removeEventListener('scroll',      closeContextMenu, { capture: true });
    },
  };
}

/** Close and remove the currently open context menu, if any. */
export function closeContextMenu() {
  if (!_current) return;
  const { el, cleanup } = _current;
  _current = null;
  cleanup();
  el.classList.remove('ctx-menu--open');
  // Remove after transition
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  // Fallback in case transition never fires (e.g. prefers-reduced-motion)
  setTimeout(() => el.remove(), 200);
}
