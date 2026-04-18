/**
 * VS Code–like sidebar with activity bar, resizable panel area, and panel registry.
 * Supports both left (default) and right placement via `options.side`.
 *
 * Usage:
 *   import { Sidebar } from './lib/sidebar.js';
 *   const sidebar = new Sidebar(document.getElementById('workspace'), {
 *     onResize: () => player.resize(),
 *   });
 *   const rightBar = new Sidebar(document.getElementById('workspace'), {
 *     side: 'right',
 *     storageKey: 'my-app.right-sidebar.v1',
 *     onResize: () => player.resize(),
 *   });
 *   sidebar.addPanel('labels',  { icon: SVG, label: 'Labels',  element: el });
 *   sidebar.setActive('labels');
 *   sidebar.setBadge('labels', '5');
 */

const CSS_PROP_LEFT = '--sidebar-width';
const CSS_PROP_RIGHT = '--sidebar-right-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 200;
const MAX_WIDTH = 600;

export class Sidebar {
  /**
   * @param {HTMLElement} workspace   The .workspace flex container
   * @param {object}      [options]
   * @param {'left'|'right'} [options.side]         Side placement (default: 'left')
   * @param {string}      [options.storageKey]    localStorage key
   * @param {number}      [options.defaultWidth]  Default sidebar width (px)
   * @param {number}      [options.minWidth]      Min sidebar width (px)
   * @param {number}      [options.maxWidth]      Max sidebar width (px)
   * @param {() => void}  [options.onResize]      Called after sidebar resize
   */
  constructor(workspace, options = {}) {
    this._workspace = workspace;
    this._side = options.side === 'right' ? 'right' : 'left';
    this._storageKey = options.storageKey || `audio-workbench.sidebar-${this._side}.v1`;
    this._cssProp = this._side === 'right' ? CSS_PROP_RIGHT : CSS_PROP_LEFT;
    this._defaultWidth = options.defaultWidth || DEFAULT_WIDTH;
    this._minWidth = options.minWidth || MIN_WIDTH;
    this._maxWidth = options.maxWidth || MAX_WIDTH;
    this._onResize = options.onResize || null;
    this._panels = new Map();
    this._activeId = null;
    this._collapsed = true;
    this._pendingActivePanel = null;

    this._build();
    this._initResize();
    this._restoreWidth();
  }

  /**
   * Register a sidebar panel.
   * @param {string} id       Unique panel id
   * @param {object} opts
   * @param {string} opts.icon   SVG string for the activity bar button
   * @param {string} opts.label  Human-readable panel title
   * @param {HTMLElement} opts.element  Panel content element (will be moved into sidebar)
   * @param {() => void} [opts.onActivate]   Called when panel becomes active
   * @param {() => void} [opts.onDeactivate] Called when panel is deactivated
   */
  addPanel(id, { icon, label, element, onActivate, onDeactivate }) {
    const btn = document.createElement('button');
    btn.className = 'activity-btn';
    btn.title = label;
    btn.dataset.panel = id;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'activity-btn-icon';
    iconSpan.innerHTML = icon;
    btn.appendChild(iconSpan);

    const textSpan = document.createElement('span');
    textSpan.className = 'activity-btn-label';
    textSpan.textContent = label;
    btn.appendChild(textSpan);

    const badge = document.createElement('span');
    badge.className = 'activity-badge';
    badge.style.display = 'none';
    btn.appendChild(badge);

    btn.addEventListener('click', () => this.toggle(id));
    this._btnGroup.appendChild(btn);

    element.removeAttribute('hidden');
    element.classList.add('sidebar-panel');
    element.style.display = 'none';
    this._body.appendChild(element);

    this._panels.set(id, { btn, badge, element, label, onActivate, onDeactivate });

    if (this._pendingActivePanel === id) {
      this._pendingActivePanel = null;
      this.setActive(id);
    }
    return this;
  }

  /** Activate a panel by id. */
  setActive(id) {
    if (!this._panels.has(id)) return;

    if (this._activeId && this._panels.has(this._activeId)) {
      const prev = this._panels.get(this._activeId);
      prev.btn.classList.remove('active');
      prev.element.style.display = 'none';
      prev.onDeactivate?.();
    }

    this._activeId = id;
    this._collapsed = false;
    const panel = this._panels.get(id);
    panel.btn.classList.add('active');
    panel.element.style.display = '';
    this._title.textContent = panel.label.toUpperCase();

    this._sidebarEl.classList.remove('collapsed');
    this._handle.style.display = '';

    panel.onActivate?.();
    this._saveState();
    this._onResize?.();
  }

  /** Toggle: if panel is active collapse, otherwise activate. */
  toggle(id) {
    if (this._activeId === id && !this._collapsed) {
      this.collapse();
    } else {
      this.setActive(id);
    }
  }

  /** Collapse sidebar (hide panel area, keep activity bar). */
  collapse() {
    if (this._activeId && this._panels.has(this._activeId)) {
      const panel = this._panels.get(this._activeId);
      panel.btn.classList.remove('active');
      panel.element.style.display = 'none';
      panel.onDeactivate?.();
    }
    this._activeId = null;
    this._collapsed = true;
    this._sidebarEl.classList.add('collapsed');
    this._handle.style.display = 'none';
    this._title.textContent = '';
    this._saveState();
    this._onResize?.();
  }

  /** Update badge text on an activity bar button. */
  setBadge(id, text) {
    const panel = this._panels.get(id);
    if (!panel) return;
    const t = text ? String(text) : '';
    panel.badge.textContent = t;
    panel.badge.style.display = t ? '' : 'none';
  }

  get activePanel() { return this._activeId; }

  /**
   * Briefly animate an activity-bar button to draw attention (without switching tabs).
   * Safe to call when the panel is already active.
   */
  flashTab(id) {
    const panel = this._panels.get(id);
    if (!panel) return;
    panel.btn.classList.remove('activity-btn--flash');
    void panel.btn.offsetWidth; // force reflow so animation restarts
    panel.btn.classList.add('activity-btn--flash');
    panel.btn.addEventListener('animationend', () => panel.btn.classList.remove('activity-btn--flash'), { once: true });
  }

  // ── DOM construction ──────────────────────────────────────────────

  _build() {
    const side = this._side;

    this._activityBar = document.createElement('div');
    this._activityBar.className = `activity-bar activity-bar--${side}`;
    this._btnGroup = document.createElement('div');
    this._btnGroup.className = 'activity-btn-group';
    this._activityBar.appendChild(this._btnGroup);

    this._sidebarEl = document.createElement('div');
    this._sidebarEl.className = `sidebar sidebar--${side} collapsed`;

    this._header = document.createElement('div');
    this._header.className = 'sidebar-header';
    this._title = document.createElement('span');
    this._title.className = 'sidebar-title';
    this._header.appendChild(this._title);
    this._sidebarEl.appendChild(this._header);

    this._body = document.createElement('div');
    this._body.className = 'sidebar-body';
    this._sidebarEl.appendChild(this._body);

    this._handle = document.createElement('div');
    this._handle.className = `sidebar-resize sidebar-resize--${side}`;
    this._handle.style.display = 'none';

    if (side === 'right') {
      // right: ... main-area | handle | sidebar | activity-bar
      this._workspace.appendChild(this._handle);
      this._workspace.appendChild(this._sidebarEl);
      this._workspace.appendChild(this._activityBar);
    } else {
      // left: activity-bar | sidebar | handle | main-area ...
      this._workspace.prepend(this._handle);
      this._workspace.prepend(this._sidebarEl);
      this._workspace.prepend(this._activityBar);
    }
  }

  // ── Horizontal resize ─────────────────────────────────────────────

  _initResize() {
    let startX = 0, startW = 0, dragging = false;
    const isRight = this._side === 'right';

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      // right sidebar: dragging left increases width
      const newW = Math.max(this._minWidth, Math.min(this._maxWidth, startW + (isRight ? -dx : dx)));
      document.documentElement.style.setProperty(this._cssProp, newW + 'px');
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      this._handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      this._saveState();
      this._onResize?.();
    };

    this._handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = this._sidebarEl.getBoundingClientRect().width;
      this._handle.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  // ── Persistence ───────────────────────────────────────────────────

  _restoreWidth() {
    try {
      const data = JSON.parse(localStorage.getItem(this._storageKey) || '{}');
      if (data.width) {
        const w = Math.max(this._minWidth, Math.min(this._maxWidth, data.width));
        document.documentElement.style.setProperty(this._cssProp, w + 'px');
      }
      if (!data.collapsed && data.activePanel) {
        this._pendingActivePanel = data.activePanel;
      }
    } catch { /* ignore */ }
  }

  _saveState() {
    try {
      const w = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(this._cssProp), 10,
      );
      localStorage.setItem(this._storageKey, JSON.stringify({
        width: w || this._defaultWidth,
        activePanel: this._activeId,
        collapsed: this._collapsed,
      }));
    } catch { /* ignore */ }
  }
}
