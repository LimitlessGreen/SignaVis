/**
 * Resizable split-panel handle.
 *
 * Usage:
 *   import { initResizeHandle } from './lib/resize-handle.js';
 *   initResizeHandle({
 *     handle:   document.getElementById('resizeHandle'),
 *     container: document.querySelector('.app'),
 *     cssProp:  '--panel-height',
 *     storageKey: 'my-app.panel-height',
 *     minPanel:  80,
 *     minStage:  120,
 *     fixedOverhead: 46,            // topbar + handle height
 *     onResizeEnd: () => player.resize(),
 *   });
 */

/**
 * @param {object} opts
 * @param {HTMLElement} opts.handle          Drag-handle element
 * @param {HTMLElement} opts.container       Outer container (for measuring total height)
 * @param {string}      [opts.cssProp]       CSS custom property name (default: '--panel-height')
 * @param {string}      [opts.storageKey]    localStorage key for persistence
 * @param {number}      [opts.defaultHeight] Default panel height in px (default: 220)
 * @param {number}      [opts.minPanel]      Minimum panel height (default: 80)
 * @param {number}      [opts.minStage]      Minimum stage height (default: 120)
 * @param {number}      [opts.fixedOverhead] Fixed pixel overhead (topbar+handle, default: 46)
 * @param {() => void}  [opts.onResizeEnd]   Callback after drag ends
 */
export function initResizeHandle(opts: any) {
  const {
    handle,
    container,
    cssProp = '--panel-height',
    storageKey,
    defaultHeight = 220,
    minPanel = 80,
    minStage = 120,
    fixedOverhead = 46,
    onResizeEnd,
  } = opts;

  // Restore saved height
  if (storageKey) {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const h = Math.max(minPanel, parseInt(saved, 10));
        document.documentElement.style.setProperty(cssProp, h + 'px');
      }
    } catch { /* ignore */ }
  }

  let startY = 0, startH = 0, dragging = false;

  const onPointerMove = (e: any) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const totalH = container.getBoundingClientRect().height;
    const newH = Math.min(
      Math.max(minPanel, startH + dy),
      totalH - fixedOverhead - minStage,
    );
    document.documentElement.style.setProperty(cssProp, newH + 'px');
  };

  const onPointerUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    if (storageKey) {
      try {
        const val = getComputedStyle(document.documentElement).getPropertyValue(cssProp).trim();
        localStorage.setItem(storageKey, String(parseInt(val, 10)));
      } catch { /* ignore */ }
    }
    onResizeEnd?.();
  };

  handle.addEventListener('pointerdown', (e: any) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(cssProp),
      10,
    ) || defaultHeight;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  });
}
