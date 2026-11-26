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
 *         { label: 'Set type', submenu: [{ label: 'song', action: … }, …] },
 *         { separator: true },
 *         { label: 'Delete', icon: '<svg…/>', action: () => doDelete(), danger: true },
 *       ],
 *     });
 *   });
 *
 * Only one menu is open at a time — calling showContextMenu() while another
 * is open closes the previous one first (with all its open submenus).
 *
 * Submenus open beside their item on hover, click, → or Enter; ← or Esc closes
 * only the submenu, a click outside every menu closes them all.
 */

/**
 * @typedef {object} ContextMenuItem
 * @property {string}      [label]     Display text.
 * @property {string}      [icon]      SVG string (optional).
 * @property {() => void}  [action]    Called when the item is activated.
 * @property {boolean}     [danger]    Red/destructive styling.
 * @property {boolean}     [disabled]  Greyed out, not interactive.
 * @property {boolean}     [separator] Renders a divider line instead of an item.
 * @property {string}      [shortcut]  Key hint shown on the right (e.g. "F2").
 * @property {string}      [heading]   Renders a small section title instead of an item.
 * @property {string}      [hint]      Short text at the right (shortcut, current value, scope).
 * @property {boolean}     [checked]   A toggle: shows on/off (role menuitemcheckbox).
 * @property {boolean}     [more]      Its action opens a further menu itself (shows ▸).
 * @property {ContextMenuItem[] | (() => ContextMenuItem[])} [submenu]
 *                                     Items of a submenu shown beside this item.
 */

const SUBMENU_DELAY = 140;

interface Level {
  el: HTMLElement;
  focusable: HTMLElement[];
  activeIdx: number;
  /** Item row of the parent level this submenu belongs to. */
  owner: HTMLElement | null;
}

let _current: { levels: Level[]; cleanup: () => void } | null = null;

function buildMenu(items: any[], open: (lvl: Level, row: HTMLElement, sub: any[]) => void, closeFrom: (depth: number) => void, depth: number): Level {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu' + (depth ? ' ctx-menu--sub' : '');
  menu.setAttribute('role', 'menu');
  const level: Level = { el: menu, focusable: [], activeIdx: -1, owner: null };
  let hoverTimer = 0;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }

    if (item.heading) {
      const h = document.createElement('div');
      h.className = 'ctx-heading';
      h.setAttribute('role', 'presentation');
      h.textContent = item.heading;
      menu.appendChild(h);
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

    if (item.shortcut) {
      const kbd = document.createElement('span');
      kbd.className = 'ctx-item-kbd';
      kbd.textContent = item.shortcut;
      row.appendChild(kbd);
    }
    if (item.hint) {
      const hintEl = document.createElement('span');
      hintEl.className = 'ctx-item-hint';
      hintEl.textContent = item.hint;
      row.appendChild(hintEl);
    }
    if (typeof item.checked === 'boolean') {
      row.setAttribute('role', 'menuitemcheckbox');
      row.setAttribute('aria-checked', String(item.checked));
      const sw = document.createElement('span');
      sw.className = 'ctx-item-switch' + (item.checked ? ' is-on' : '');
      row.appendChild(sw);
    }
    const hasSub = !!item.submenu;
    if (item.more || hasSub) {
      row.setAttribute('aria-haspopup', 'menu');
      const m = document.createElement('span');
      m.className = 'ctx-item-more';
      m.textContent = '▸';
      row.appendChild(m);
    }

    if (!item.disabled) {
      const subItems = () => (typeof item.submenu === 'function' ? item.submenu() : item.submenu) || [];
      if (hasSub) {
        (row as any)._openSub = () => open(level, row, subItems());
        row.addEventListener('click', (e) => { e.stopPropagation(); (row as any)._openSub(); });
      } else {
        row.addEventListener('click', () => {
          closeContextMenu();
          item.action?.();
        });
      }
      level.focusable.push(row);
    }
    // Hover: open this item's submenu (after a short pause), or close a sibling's
    row.addEventListener('pointerenter', () => {
      clearTimeout(hoverTimer);
      const i = level.focusable.indexOf(row);
      if (i >= 0) setActive(level, i, false);
      hoverTimer = window.setTimeout(() => {
        if (hasSub && !item.disabled) (row as any)._openSub();
        else closeFrom(depth + 1);
      }, SUBMENU_DELAY);
    });
    row.addEventListener('pointerleave', () => clearTimeout(hoverTimer));

    menu.appendChild(row);
  }
  return level;
}

function setActive(level: Level, idx: number, focus = true) {
  level.activeIdx = Math.max(0, Math.min(level.focusable.length - 1, idx));
  level.focusable.forEach((r, i) => r.classList.toggle('ctx-item--active', i === level.activeIdx));
  if (focus) level.focusable[level.activeIdx]?.focus({ preventScroll: true });
}

/** Place a menu at x/y (or beside an item row), kept inside the viewport. */
function place(el: HTMLElement, x: number, y: number, beside?: DOMRect) {
  document.body.appendChild(el);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = x;
  let top = y;
  if (beside) {
    left = beside.right - 2;
    top = beside.top - 5;   // first item lines up with the parent item (menu padding)
    if (left + mw > vw - 4) {
      left = beside.left - mw + 2;   // no room on the right: open to the left
      el.classList.add('ctx-menu--left');
    }
  }
  if (left + mw > vw - 4) left = Math.max(4, vw - mw - 4);
  if (left < 4) left = 4;
  if (top + mh > vh - 4) top = Math.max(4, vh - mh - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  requestAnimationFrame(() => el.classList.add('ctx-menu--open'));
}

/**
 * Show a context menu at the given viewport coordinates.
 *
 * @param {{ x: number, y: number, items: ContextMenuItem[] }} opts
 */
export function showContextMenu({ x, y, items }: any) {
  closeContextMenu();

  const levels: Level[] = [];

  const closeFrom = (depth: number) => {
    while (levels.length > depth) {
      const l = levels.pop()!;
      l.owner?.classList.remove('ctx-item--open');
      l.owner?.setAttribute('aria-expanded', 'false');
      removeMenu(l.el);
    }
  };

  const open = (parent: Level, row: HTMLElement, sub: any[], focusFirst = false) => {
    if (_current?.levels !== levels) return;   // menu already dismissed (late hover timer)
    const depth = levels.indexOf(parent) + 1;
    if (levels[depth]?.owner === row) {   // already open
      if (focusFirst) setActive(levels[depth], 0);
      return;
    }
    closeFrom(depth);
    if (!sub.length) return;
    const lvl = buildMenu(sub, open, closeFrom, depth);
    lvl.owner = row;
    row.classList.add('ctx-item--open');
    row.setAttribute('aria-expanded', 'true');
    levels.push(lvl);
    place(lvl.el, 0, 0, row.getBoundingClientRect());
    if (focusFirst) setActive(lvl, 0);
  };

  const root = buildMenu(items, open, closeFrom, 0);
  levels.push(root);
  place(root.el, x, y);

  // ── Keyboard navigation (on the deepest open menu) ───────────────────────
  function onKey(e: any) {
    const lvl = levels[levels.length - 1];
    const cur = lvl.focusable[lvl.activeIdx] as any;
    // Menu keys stay in the menu (the label table would move its cursor or start an edit)
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(e.key)) e.stopPropagation();
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (levels.length > 1) { closeFrom(levels.length - 1); levels[levels.length - 1].focusable[levels[levels.length - 1].activeIdx]?.focus({ preventScroll: true }); }
      else closeContextMenu();
    } else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive(lvl, lvl.activeIdx < 0 ? 0 : lvl.activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive(lvl, lvl.activeIdx < 0 ? lvl.focusable.length - 1 : lvl.activeIdx - 1); }
    else if (e.key === 'ArrowRight' && cur?._openSub) {
      e.preventDefault();
      cur._openSub();
      const sub = levels[levels.length - 1];
      if (sub !== lvl) setActive(sub, 0);
    } else if (e.key === 'ArrowLeft' && levels.length > 1) {
      e.preventDefault();
      closeFrom(levels.length - 1);
      const up = levels[levels.length - 1];
      up.focusable[up.activeIdx]?.focus({ preventScroll: true });
    } else if (e.key === 'Enter' && lvl.activeIdx >= 0) {
      e.preventDefault();
      if (cur?._openSub) {
        cur._openSub();
        const sub = levels[levels.length - 1];
        if (sub !== lvl) setActive(sub, 0);
      } else cur?.click();
    }
  }

  // ── Auto-close ───────────────────────────────────────────────────────────
  function onPointerDown(e: any) {
    if (!levels.some((l) => l.el.contains(e.target))) closeContextMenu();
  }

  document.addEventListener('keydown',     onKey,        { capture: true });
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  window  .addEventListener('blur',        closeContextMenu);
  window  .addEventListener('scroll',      closeContextMenu, { once: true, capture: true });

  _current = {
    levels,
    cleanup() {
      document.removeEventListener('keydown',     onKey,        { capture: true });
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window  .removeEventListener('blur',        closeContextMenu);
      window  .removeEventListener('scroll',      closeContextMenu, { capture: true });
    },
  };
}

function removeMenu(el: HTMLElement) {
  el.classList.remove('ctx-menu--open');
  // Remove after transition
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  // Fallback in case transition never fires (e.g. prefers-reduced-motion)
  setTimeout(() => el.remove(), 200);
}

/** Close and remove the currently open context menu (and its submenus), if any. */
export function closeContextMenu() {
  if (!_current) return;
  const { levels, cleanup } = _current;
  _current = null;
  cleanup();
  for (const l of levels) removeMenu(l.el);
}
