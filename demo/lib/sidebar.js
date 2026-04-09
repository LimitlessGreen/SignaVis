/**
 * VS Code–like sidebar with activity bar, resizable panel area, and panel registry.
 *
 * Usage:
 *   import { Sidebar } from './lib/sidebar.js';
 *   const sidebar = new Sidebar(document.getElementById('workspace'), {
 *     onResize: () => player.resize(),
 *   });
 *   sidebar.addPanel('labels',  { icon: SVG, label: 'Labels',  element: el });
 *   sidebar.addPanel('birdnet', { icon: SVG, label: 'BirdNET', element: el });
 *   sidebar.setActive('labels');
 *   sidebar.setBadge('labels', '5');
 */

const CSS_PROP = '--sidebar-width';
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 200;
const MAX_WIDTH = 600;

export class Sidebar {
  /**
   * @param {HTMLElement} workspace   The .workspace flex container
   * @param {object}      [options]
   * @param {string}      [options.storageKey]    localStorage key
   * @param {number}      [options.defaultWidth]  Default sidebar width (px)
   * @param {number}      [options.minWidth]      Min sidebar width (px)
   * @param {number}      [options.maxWidth]      Max sidebar width (px)
   * @param {() => void}  [options.onResize]      Called after sidebar resize
   */
  constructor(workspace, options = {}) {
    this._workspace = workspace;
    this._storageKey = options.storageKey || 'audio-workbench.sidebar.v1';
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
    btn.innerHTML = icon;
    btn.dataset.panel = id;

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

  // ── DOM construction ──────────────────────────────────────────────

  _build() {
    this._activityBar = document.createElement('div');
    this._activityBar.className = 'activity-bar';
    this._btnGroup = document.createElement('div');
    this._btnGroup.className = 'activity-btn-group';
    this._activityBar.appendChild(this._btnGroup);

    this._sidebarEl = document.createElement('div');
    this._sidebarEl.className = 'sidebar collapsed';

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
    this._handle.className = 'sidebar-resize';
    this._handle.style.display = 'none';

    this._workspace.prepend(this._handle);
    this._workspace.prepend(this._sidebarEl);
    this._workspace.prepend(this._activityBar);
  }

  // ── Horizontal resize ─────────────────────────────────────────────

  _initResize() {
    let startX = 0, startW = 0, dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const newW = Math.max(this._minWidth, Math.min(this._maxWidth, startW + dx));
      document.documentElement.style.setProperty(CSS_PROP, newW + 'px');
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
        document.documentElement.style.setProperty(CSS_PROP, w + 'px');
      }
      if (!data.collapsed && data.activePanel) {
        this._pendingActivePanel = data.activePanel;
      }
    } catch { /* ignore */ }
  }

  _saveState() {
    try {
      const w = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(CSS_PROP), 10,
      );
      localStorage.setItem(this._storageKey, JSON.stringify({
        width: w || this._defaultWidth,
        activePanel: this._activeId,
        collapsed: this._collapsed,
      }));
    } catch { /* ignore */ }
  }
}
