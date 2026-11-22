/**
 * Mode tiles: a row of large tabs that each show one pane of a sidebar tab.
 *
 * Markup: `.mode-tiles[role=tablist] > button.mode-tile[role=tab][aria-controls=<pane id>]`,
 * panes are any elements with those ids. The choice is remembered per `storageKey`.
 */
import { prefs } from '../../infrastructure/storage/prefs.ts';
export function initModeTiles(root: HTMLElement | null, storageKey?: string): (id: string) => void {
  const tiles = root ? [...root.querySelectorAll<HTMLButtonElement>('.mode-tile')] : [];
  const select = (paneId: string, focus = false) => {
    if (!tiles.some((t) => t.getAttribute('aria-controls') === paneId)) return;
    for (const t of tiles) {
      const on = t.getAttribute('aria-controls') === paneId;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const pane = document.getElementById(t.getAttribute('aria-controls') || '');
      if (pane) pane.hidden = !on;
      if (on && focus) t.focus();
    }
    if (storageKey) prefs.set(storageKey, paneId);
  };
  tiles.forEach((t, i) => {
    t.addEventListener('click', () => select(t.getAttribute('aria-controls') || ''));
    t.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      select(tiles[(i + step + tiles.length) % tiles.length].getAttribute('aria-controls') || '', true);
    });
  });
  if (storageKey) { const s = prefs.get(storageKey); if (s) select(s); }
  return (id) => select(id);
}
