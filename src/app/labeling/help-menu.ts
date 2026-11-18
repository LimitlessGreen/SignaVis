// "?" help popover in the top bar: grouped actions with icons, a search that
// also finds keyboard shortcuts from the help panel, arrow-key navigation and
// a global "?" key that opens the shortcut overview.
import { CircleHelp, Keyboard, Lightbulb, PlayCircle, RotateCcw, Info, Shield, Heart, Search, Bug } from 'lucide-static';

export interface HelpItem {
  group: string;
  icon: string;
  label: string;
  hint?: string;
  kbd?: string;
  keywords?: string;
  action: () => void;
}

export interface Shortcut { keys: string; desc: string }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Items and shortcuts matching every word of the query (empty query → all items, no shortcuts). */
export function filterHelp(items: HelpItem[], shortcuts: Shortcut[], query: string): { items: HelpItem[]; shortcuts: Shortcut[] } {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { items, shortcuts: [] };
  const hit = (text: string) => { const t = norm(text); return words.every((w) => t.includes(w)); };
  return {
    items: items.filter((i) => hit(`${i.label} ${i.hint ?? ''} ${i.keywords ?? ''} ${i.group}`)),
    shortcuts: shortcuts.filter((s) => hit(`${s.keys} ${s.desc}`)).slice(0, 8),
  };
}

/** Reads the `<kbd>` / `.sc-desc` pairs of the help panel's shortcut grids. */
export function readShortcuts(root: ParentNode | null): Shortcut[] {
  if (!root) return [];
  const out: Shortcut[] = [];
  root.querySelectorAll('.shortcut-grid').forEach((grid) => {
    grid.querySelectorAll('kbd').forEach((k) => {
      const d = k.nextElementSibling;
      if (d?.classList.contains('sc-desc')) out.push({ keys: k.textContent?.trim() ?? '', desc: d.textContent?.trim() ?? '' });
    });
  });
  return out;
}

export const HELP_ICONS = { CircleHelp, Keyboard, Lightbulb, PlayCircle, RotateCcw, Info, Shield, Heart, Bug };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function initHelpMenu(opts: {
  button: HTMLElement | null;
  items: HelpItem[];
  shortcutsRoot: ParentNode | null;
  onShowShortcuts: () => void;
}): void {
  const { items, shortcutsRoot, onShowShortcuts } = opts;
  const button = opts.button;
  if (!button) return;
  const btn: HTMLElement = button;
  button.innerHTML = CircleHelp;
  button.setAttribute('aria-expanded', 'false');

  const pop = document.createElement('div');
  pop.className = 'help-pop';
  pop.inert = true;
  pop.innerHTML = `
    <label class="help-pop__search">${Search}<input type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="helpPopList" placeholder="Search help &amp; shortcuts…" aria-label="Search help and shortcuts"></label>
    <div class="help-pop__list" id="helpPopList" role="listbox" aria-label="Help"></div>
    <div class="help-pop__foot"><span>Press <kbd>?</kbd> for all shortcuts</span></div>`;
  document.body.appendChild(pop);
  const input = pop.querySelector('input')!;
  const list = pop.querySelector<HTMLElement>('.help-pop__list')!;
  let shortcuts: Shortcut[] | null = null;
  let active = 0;
  let isOpen = false;

  const rows = () => [...list.querySelectorAll<HTMLElement>('.help-pop__item')];
  const setActive = (i: number) => {
    const r = rows();
    if (!r.length) return;
    active = (i + r.length) % r.length;
    r.forEach((el, j) => {
      el.classList.toggle('is-active', j === active);
      el.setAttribute('aria-selected', String(j === active));
    });
    input.setAttribute('aria-activedescendant', r[active].id);
    r[active].scrollIntoView({ block: 'nearest' });
  };

  const render = () => {
    shortcuts ??= readShortcuts(shortcutsRoot);
    const res = filterHelp(items, shortcuts, input.value);
    let html = '';
    let group = '';
    res.items.forEach((it, i) => {
      if (it.group !== group) { group = it.group; html += `<div class="help-pop__group">${esc(group)}</div>`; }
      html += `<button type="button" class="help-pop__item" role="option" id="helpPopItem${i}" data-i="${i}">
        <span class="help-pop__icon">${it.icon}</span>
        <span class="help-pop__text"><span class="help-pop__label">${esc(it.label)}</span>${it.hint ? `<span class="help-pop__hint">${esc(it.hint)}</span>` : ''}</span>
        ${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`;
    });
    if (res.shortcuts.length) {
      html += `<div class="help-pop__group">Shortcuts</div>`;
      res.shortcuts.forEach((s, j) => {
        html += `<button type="button" class="help-pop__item help-pop__item--sc" role="option" id="helpPopSc${j}" data-sc="1">
          <span class="help-pop__text"><span class="help-pop__label">${esc(s.desc)}</span></span><kbd>${esc(s.keys)}</kbd></button>`;
      });
    }
    if (!html) { input.removeAttribute('aria-activedescendant'); }
    if (!html) html = `<div class="help-pop__empty">Nothing found — try “zoom” or “label”.</div>`;
    list.innerHTML = html;
    list.querySelectorAll<HTMLElement>('.help-pop__item').forEach((el) => {
      el.addEventListener('click', () => {
        close();
        if (el.dataset.sc) onShowShortcuts();
        else res.items[Number(el.dataset.i)]?.action();
      });
      el.addEventListener('pointermove', () => setActive(rows().indexOf(el)));
      el.addEventListener('focus', () => setActive(rows().indexOf(el)));
    });
    setActive(0);
  };

  const place = () => {
    const r = button.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
  };
  const open = () => {
    if (isOpen) return;
    isOpen = true;
    input.value = '';
    render();
    place();
    pop.inert = false;
    pop.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('is-active');
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  };
  function close() {
    if (!isOpen) return;
    isOpen = false;
    pop.classList.remove('is-open');
    pop.inert = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('is-active');
  }

  button.addEventListener('click', () => (isOpen ? close() : open()));
  input.addEventListener('input', render);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    // Enter in the search runs the highlighted row; on a focused row the button handles it natively
    else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); rows()[active]?.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); button.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (isOpen && !pop.contains(e.target as Node) && !button.contains(e.target as Node)) close();
  });
  window.addEventListener('resize', () => { if (isOpen) place(); });

  // Global "?" → shortcut overview
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('.help-dialog')) return;
    e.preventDefault();
    close();
    onShowShortcuts();
  });
}
