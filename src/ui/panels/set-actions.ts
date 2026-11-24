// set-actions.ts — one action model for label sets, shared by the Project tab (Sets block)
// and the Labels tab (source headers): ⋯ button, right-click, keyboard and the action bar
// of the selected set all come from here, so both places offer the same things.

import { showContextMenu } from '../components/context-menu/context-menu.ts';

export type SetKind = 'own' | 'manual' | 'imported';
/** 'session': all recordings (Project tab); 'recording': the recording on screen (Labels tab). */
export type SetScope = 'session' | 'recording';

export interface SetDesc {
  id: string;
  name: string;
  kind: SetKind;
  /** Labels can't be edited (imported, or locked by the user). */
  locked: boolean;
  /** The user may lock/unlock it (XC sets stay locked). */
  lockable: boolean;
  hidden: boolean;
  /** All other sets are hidden ("show only this set" is on). */
  solo: boolean;
  /** Source page of an imported set. */
  uri?: string;
  /** "xeno-canto", "BirdNET", … for the source link. */
  sourceName?: string;
  /** Labels "Copy to mine" would still copy. */
  pending: number;
  /** Labels of this set in the scope. */
  total: number;
  /** Recordings with labels of this set (session-wide). */
  recordings: number;
  scope: SetScope;
  /** "Show labels already in my labels" toggle: null = not offered. */
  showAdopted?: boolean | null;
}

export interface SetHandlers {
  rename?: () => void;
  toggleHidden?: () => void;
  solo?: () => void;
  adopt?: () => void;
  toggleAdopted?: () => void;
  toggleLock?: () => void;
  openSource?: () => void;
  /** 'recording': only the recording on screen; 'all': every recording. */
  remove?: (where: 'recording' | 'all') => void;
  addLayer?: () => void;
  /** Extra own-set items (layers) for the menu. */
  extraItems?: () => any[];
}

export interface BarAction { key: string; label: string; title: string; icon: string; tone?: 'primary' | 'danger'; action: () => void }

export const SET_ICON = {
  eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8s2-4 6-4 6 4 6 4"/><path d="M2 2l12 12"/><circle cx="8" cy="8" r="2"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Remove entries for a set: wording and scope depend on kind and where the user is. */
function removeEntries(s: SetDesc, h: SetHandlers): any[] {
  if (!h.remove) return [];
  const many = s.recordings > 1;
  if (s.kind === 'own') {
    // The own set itself stays (it is the upload set) — only its labels go
    if (s.scope === 'recording') {
      const out = [{ label: 'Clear my labels in this recording', shortcut: 'Del', danger: true, disabled: !s.total, action: () => h.remove!('recording') }];
      if (many) out.push({ label: `Clear my labels in all ${s.recordings} recordings`, shortcut: '', danger: true, disabled: false, action: () => h.remove!('all') });
      return out;
    }
    return [{ label: many ? `Clear my labels in all ${s.recordings} recordings` : 'Clear my labels', shortcut: 'Del', danger: true, disabled: !s.recordings, action: () => h.remove!('all') }];
  }
  if (s.scope === 'recording' && many) {
    return [
      { label: 'Remove from this recording', shortcut: 'Del', danger: true, action: () => h.remove!('recording') },
      { label: `Remove from all ${s.recordings} recordings`, danger: true, action: () => h.remove!('all') },
    ];
  }
  return [{ label: 'Remove set', shortcut: 'Del', danger: true, action: () => h.remove!('all') }];
}

/** Items of the set's ⋯ / right-click menu. Missing handlers leave their entries out. */
export function setMenuItems(s: SetDesc, h: SetHandlers): any[] {
  const groups: any[][] = [[], [], [], []];
  const [view, edit, extra, danger] = groups;
  if (h.adopt && s.kind === 'imported' && s.pending > 0) {
    view.push({ label: `Copy ${plural(s.pending, 'label')} to my labels`, shortcut: 'C', action: h.adopt });
  }
  if (h.toggleHidden) view.push({ label: s.hidden ? 'Show on spectrogram' : 'Hide on spectrogram', shortcut: 'H', action: h.toggleHidden });
  if (h.solo) view.push({ label: s.solo ? 'Show all sets' : 'Show only this set', action: h.solo });
  if (h.toggleAdopted && s.kind === 'imported' && s.showAdopted != null) {
    view.push({ label: s.showAdopted ? 'Hide labels already in my labels' : 'Show labels already in my labels', action: h.toggleAdopted });
  }
  if (h.rename) edit.push({ label: 'Rename…', shortcut: 'F2', action: h.rename });
  if (h.addLayer && s.kind === 'own') edit.push({ label: 'New layer…', action: h.addLayer });
  if (h.toggleLock && s.lockable) edit.push({ label: s.locked ? 'Unlock (allow editing)' : 'Lock (prevent editing)', action: h.toggleLock });
  if (h.openSource && s.uri) edit.push({ label: `Open on ${s.sourceName || 'source page'} ↗`, action: h.openSource });
  if (h.extraItems) extra.push(...h.extraItems());
  danger.push(...removeEntries(s, h));
  const items: any[] = [];
  for (const g of groups) {
    if (!g.length) continue;
    if (items.length) items.push({ separator: true });
    items.push(...g);
  }
  return items.length ? items : [{ label: 'No actions', disabled: true }];
}

/** Labelled buttons of the selected set (the few frequent actions; the rest is in ⋯). */
export function setBarActions(s: SetDesc, h: SetHandlers): BarAction[] {
  const out: BarAction[] = [];
  if (h.adopt && s.kind === 'imported' && s.pending > 0) {
    out.push({ key: 'adopt', label: `Copy ${s.pending}`, title: `Copy ${plural(s.pending, 'label')} into my labels (undo possible)`, icon: SET_ICON.copy, tone: 'primary', action: h.adopt });
  }
  if (h.rename) out.push({ key: 'rename', label: 'Rename', title: 'Rename (F2)', icon: SET_ICON.pen, action: h.rename });
  if (h.addLayer && s.kind === 'own') out.push({ key: 'layer', label: 'Layer', title: 'New layer: new labels go there', icon: SET_ICON.plus, action: h.addLayer });
  if (h.openSource && s.uri) {
    const src = s.sourceName === 'xeno-canto' ? 'XC' : 'Source';
    out.push({ key: 'source', label: src, title: `Open on ${s.sourceName || 'source page'}`, icon: SET_ICON.ext, action: h.openSource });
  }
  const first = removeEntries(s, h)[0];   // never fall back to a wider scope
  const rm = first && !first.disabled ? first : null;
  if (rm) out.push({ key: 'remove', label: s.kind === 'own' ? 'Clear' : 'Remove', title: `${rm.label} (Del, undo possible)`, icon: SET_ICON.trash, tone: 'danger', action: rm.action });
  return out;
}

/** Keyboard shortcut on a focused set row: F2 rename, Del remove (first entry), H hide, C copy. */
export function setKeyAction(s: SetDesc, h: SetHandlers, e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): (() => void) | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'F2') return h.rename || null;
  if (e.key === 'Delete') { const first = removeEntries(s, h)[0]; return first && !first.disabled ? first.action : null; }
  if (e.key === 'h' || e.key === 'H') return h.toggleHidden || null;
  if ((e.key === 'c' || e.key === 'C') && s.kind === 'imported' && s.pending > 0) return h.adopt || null;
  return null;
}

// ── DOM ─────────────────────────────────────────────────────────────

function btn(cls: string, html: string, title: string, onClick: (e: MouseEvent) => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = html;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

/** Open the set menu below a button, or at the pointer for right-click. */
export function openSetMenu(e: MouseEvent | KeyboardEvent, s: SetDesc, h: SetHandlers) {
  const t = (e.currentTarget || e.target) as HTMLElement | null;
  const r = e.type === 'contextmenu' && (e as MouseEvent).clientX ? null : t?.getBoundingClientRect?.();
  const x = r ? r.left : (e as MouseEvent).clientX;
  const y = r ? r.bottom + 2 : (e as MouseEvent).clientY;
  showContextMenu({ x, y, items: setMenuItems(s, h) });
}

/** Always-visible eye + ⋯ buttons of a set row. */
export function buildSetControls(s: SetDesc, h: SetHandlers): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'set-ctl';
  if (h.toggleHidden) {
    const eye = btn(`set-ctl-btn set-ctl-eye${s.hidden ? ' is-off' : ''}`, s.hidden ? SET_ICON.eyeOff : SET_ICON.eye,
      s.hidden ? 'Hidden — show on spectrogram (H)' : 'Shown — hide on spectrogram (H)', () => h.toggleHidden!());
    eye.setAttribute('aria-pressed', String(!s.hidden));
    wrap.appendChild(eye);
  }
  const more = btn('set-ctl-btn set-ctl-more', SET_ICON.more, 'Set actions', (e) => openSetMenu(e, s, h));
  more.setAttribute('aria-haspopup', 'menu');
  wrap.appendChild(more);
  return wrap;
}

/** Action bar of the selected set: one line of small labelled buttons. */
export function buildSetBar(s: SetDesc, h: SetHandlers): HTMLElement | null {
  const acts = setBarActions(s, h);
  if (!acts.length) return null;
  const bar = document.createElement('div');
  bar.className = 'set-bar';
  for (const a of acts) {
    const b = btn(`set-bar-btn${a.tone ? ` set-bar-btn--${a.tone}` : ''}`, `${a.icon}<span>${a.label}</span>`, a.title, () => a.action());
    b.dataset.act = a.key;
    bar.appendChild(b);
  }
  return bar;
}

/**
 * Inline rename: replaces the text of `host` with an input. Enter/blur saves, Esc cancels.
 * `onCommit` gets the new name only when it changed; `onEnd` runs in any case.
 */
export function startInlineRename(host: HTMLElement, oldName: string, onCommit: (name: string) => void, onEnd?: () => void) {
  if (host.querySelector('input')) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'inline-name-input set-rename-input';
  inp.value = oldName;
  inp.setAttribute('aria-label', 'Set name');
  const before = [...host.childNodes];
  host.replaceChildren(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const val = inp.value.trim();
    host.replaceChildren(...before);
    if (save && val && val !== oldName) {
      const first = before.find((n) => n.nodeType === 3);
      if (first) first.textContent = val; else host.prepend(val);
      onCommit(val);
    }
    onEnd?.();
  };
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  inp.addEventListener('click', (ev) => ev.stopPropagation());
  inp.addEventListener('dblclick', (ev) => ev.stopPropagation());
}
