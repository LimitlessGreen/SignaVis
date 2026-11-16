/**
 * Phone shell — replaces the activity bars and sidebars on small screens.
 *
 * On phones (see PHONE_QUERY) the two {@link Sidebar}s are not shown as side columns.
 * Instead a tab bar sits at the bottom of the screen and the active panel slides up
 * as a bottom sheet over the player. The sidebars and their panels are reused as they
 * are: the shell only drives them (setActive / collapse) and CSS (`html.is-phone`)
 * turns the open `.sidebar` into the sheet. Only one sheet is open at a time.
 *
 * Sheet gestures: drag the sheet header up to expand to full height, down to shrink
 * or close. Tapping the header toggles half/full.
 *
 * See plans/mobile-ui-plan.md.
 */
import type { Sidebar } from './sidebar.ts';

/** Phones in portrait, and phones in landscape (low height + touch). */
export const PHONE_QUERY = '(max-width: 600px), (pointer: coarse) and (max-height: 500px)';

export interface MobileTab {
  /** Panel id inside `bar`. */
  id: string;
  bar: Sidebar;
  label: string;
  /** SVG markup. */
  icon: string;
}

export interface MobileShellOptions {
  /** Where the tab bar is appended (the app grid). */
  host: HTMLElement;
  /** Tabs shown directly in the tab bar (keep it at 4). */
  tabs: MobileTab[];
  /** Panels reachable via the "More" tab. */
  more?: MobileTab[];
  moreIcon?: string;
  /** Called after the layout changed (player needs a resize). */
  onLayout?: () => void;
  /** Called when phone mode is entered (true) or left (false). */
  onModeChange?: (phone: boolean) => void;
}

type SheetSize = 'half' | 'full';

export class MobileShell {
  private opts: MobileShellOptions;
  private bars: Sidebar[];
  private mql: MediaQueryList;
  private tabBar: HTMLElement;
  private moreSheet: HTMLElement;
  private tabButtons = new Map<string, HTMLButtonElement>();
  private moreBtn: HTMLButtonElement | null = null;
  private size: SheetSize = 'half';
  private phone = false;

  constructor(opts: MobileShellOptions) {
    this.opts = opts;
    const all = [...opts.tabs, ...(opts.more ?? [])];
    this.bars = [...new Set(all.map((t) => t.bar))];
    this.tabBar = this.buildTabBar();
    this.moreSheet = this.buildMoreSheet();
    opts.host.append(this.tabBar, this.moreSheet);

    for (const bar of this.bars) {
      this.decorateSheetHeader(bar);
      bar.onChange = (id) => this.onBarChange(bar, id);
    }

    this.mql = window.matchMedia(PHONE_QUERY);
    this.mql.addEventListener('change', () => this.apply());
    this.apply();
  }

  get isPhone() { return this.phone; }

  // ── Mode switching ─────────────────────────────────────────────────

  private apply() {
    const phone = this.mql.matches;
    if (phone === this.phone && document.documentElement.classList.contains('is-phone') === phone) return;
    this.phone = phone;
    document.documentElement.classList.toggle('is-phone', phone);
    if (phone) {
      // Start with the player in full view: no sheet open.
      for (const bar of this.bars) if (!bar.collapsed) bar.collapse();
      this.setSize('half');
    }
    this.closeMore();
    this.syncTabs();
    this.opts.onModeChange?.(phone);
    this.opts.onLayout?.();
  }

  private onBarChange(bar: Sidebar, id: string | null) {
    if (this.phone && id) {
      // One sheet at a time.
      for (const other of this.bars) if (other !== bar && !other.collapsed) other.collapse();
      this.closeMore();
    }
    this.syncTabs();
  }

  // ── Tab bar ────────────────────────────────────────────────────────

  private buildTabBar(): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'mobile-tabbar';
    nav.setAttribute('aria-label', 'Main');
    for (const tab of this.opts.tabs) {
      const btn = this.makeTabButton(tab.label, tab.icon);
      btn.addEventListener('click', () => this.openTab(tab));
      this.tabButtons.set(this.key(tab), btn);
      nav.appendChild(btn);
    }
    if (this.opts.more?.length) {
      const btn = this.makeTabButton('More', this.opts.moreIcon ?? DOTS_ICON);
      btn.setAttribute('aria-haspopup', 'menu');
      btn.addEventListener('click', () => this.toggleMore());
      this.moreBtn = btn;
      nav.appendChild(btn);
    }
    return nav;
  }

  private makeTabButton(label: string, icon: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mobile-tab';
    btn.innerHTML = `<span class="mobile-tab-icon" aria-hidden="true">${icon}</span><span class="mobile-tab-label"></span>`;
    (btn.querySelector('.mobile-tab-label') as HTMLElement).textContent = label;
    return btn;
  }

  private key(tab: MobileTab) { return `${this.bars.indexOf(tab.bar)}:${tab.id}`; }

  private openTab(tab: MobileTab) {
    this.closeMore();
    if (tab.bar.activePanel === tab.id && !tab.bar.collapsed) { tab.bar.collapse(); return; }
    this.setSize('half');
    tab.bar.setActive(tab.id);
  }

  private syncTabs() {
    let anyMoreActive = false;
    const moreKeys = new Set((this.opts.more ?? []).map((t) => this.key(t)));
    for (const bar of this.bars) {
      const id = bar.collapsed ? null : bar.activePanel;
      const k = id ? `${this.bars.indexOf(bar)}:${id}` : null;
      if (k && moreKeys.has(k)) anyMoreActive = true;
    }
    for (const tab of this.opts.tabs) {
      const btn = this.tabButtons.get(this.key(tab));
      const active = !tab.bar.collapsed && tab.bar.activePanel === tab.id;
      btn?.classList.toggle('active', active);
      btn?.setAttribute('aria-pressed', String(active));
    }
    this.moreBtn?.classList.toggle('active', anyMoreActive || this.moreSheet.classList.contains('open'));
  }

  // ── "More" menu ────────────────────────────────────────────────────

  private buildMoreSheet(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mobile-more';
    el.setAttribute('role', 'menu');
    for (const tab of this.opts.more ?? []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mobile-more-item';
      btn.setAttribute('role', 'menuitem');
      btn.innerHTML = `<span class="mobile-tab-icon" aria-hidden="true">${tab.icon}</span><span></span>`;
      (btn.lastElementChild as HTMLElement).textContent = tab.label;
      btn.addEventListener('click', () => this.openTab(tab));
      el.appendChild(btn);
    }
    return el;
  }

  private toggleMore() {
    if (this.moreSheet.classList.contains('open')) { this.closeMore(); this.syncTabs(); return; }
    for (const bar of this.bars) if (!bar.collapsed) bar.collapse();
    this.moreSheet.classList.add('open');
    this.syncTabs();
  }

  private closeMore() { this.moreSheet.classList.remove('open'); }

  // ── Sheet header: grab handle, close button, drag gesture ───────────

  private decorateSheetHeader(bar: Sidebar) {
    const sheet = bar.element;
    const header = sheet.querySelector('.sidebar-header') as HTMLElement | null;
    if (!header) return;

    const grip = document.createElement('span');
    grip.className = 'sheet-grip';
    grip.setAttribute('aria-hidden', 'true');
    header.prepend(grip);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sheet-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); bar.collapse(); });
    header.appendChild(close);

    let startY = 0;
    let startH = 0;
    let dragging = false;
    let moved = false;

    header.addEventListener('pointerdown', (e) => {
      if (!this.phone || (e.target as HTMLElement).closest('.sheet-close')) return;
      dragging = true;
      moved = false;
      startY = e.clientY;
      startH = sheet.getBoundingClientRect().height;
      header.setPointerCapture(e.pointerId);
      sheet.classList.add('sheet-dragging');
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 6) moved = true;
      const h = Math.max(80, Math.min(this.maxSheetHeight(), startH - dy));
      sheet.style.height = `${h}px`;
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('sheet-dragging');
      sheet.style.height = '';
      const dy = e.clientY - startY;
      if (!moved) { this.setSize(this.size === 'half' ? 'full' : 'half'); return; }
      if (dy > 0) {
        // Dragged down: full → half, half → closed.
        if (this.size === 'full' && startH - dy > this.maxSheetHeight() * 0.45) this.setSize('half');
        else bar.collapse();
      } else {
        this.setSize('full');
      }
      this.opts.onLayout?.();
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  }

  private maxSheetHeight() {
    const tab = this.tabBar.getBoundingClientRect().height;
    return window.innerHeight - tab - 48;
  }

  private setSize(size: SheetSize) {
    this.size = size;
    document.documentElement.dataset.sheet = size;
  }
}

const DOTS_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
