// One-time, non-modal hint that SignaVis has a community on Telegram.
// Shown from the second app start on, a while after loading and only when no
// dialog is open; closing it or following the link hides it for good. The
// help menu and the About dialog keep a permanent link.
import { MessagesSquare, X } from 'lucide-static';
import { prefsStorage } from '../../infrastructure/storage/prefs.ts';

export const COMMUNITY_URL = 'https://t.me/SignaVis';
export const COMMUNITY_HINT_KEY = 'signavis.community-hint.v1';

/** Starts counted so far and whether the hint was closed or used. */
export interface CommunityHintState { starts: number; closed: boolean }

type Store = Pick<Storage, 'getItem' | 'setItem'> | null;

export function readCommunityHint(storage: Store): CommunityHintState {
  try {
    const raw = JSON.parse(storage?.getItem(COMMUNITY_HINT_KEY) ?? 'null');
    const starts = Number.isFinite(raw?.starts) ? Math.max(0, Math.floor(raw.starts)) : 0;
    return { starts, closed: raw?.closed === true };
  } catch {
    return { starts: 0, closed: false };
  }
}

export function writeCommunityHint(storage: Store, state: CommunityHintState): void {
  try { storage?.setItem(COMMUNITY_HINT_KEY, JSON.stringify(state)); } catch { /* private mode etc. */ }
}

/** Count this app start; returns the new state. */
export function recordStart(storage: Store): CommunityHintState {
  const s = readCommunityHint(storage);
  if (s.closed) return s;
  const next = { starts: s.starts + 1, closed: false };
  writeCommunityHint(storage, next);
  return next;
}

/** Not on the very first start (onboarding and tips come first), never again once closed. */
export const shouldShowCommunityHint = (s: CommunityHintState): boolean => !s.closed && s.starts >= 2;

const BLOCKING = '.app-modal-backdrop:not([hidden]), .label-editor-backdrop, .geo-map-backdrop, .field-schema-backdrop:not([hidden]), .xc-nokey-backdrop:not([hidden])';

export interface CommunityHintOptions {
  doc?: Document;
  /** Wait after start before the first attempt (ms). */
  delay?: number;
  /** Retry interval while a dialog is open (ms) and number of attempts per session. */
  retry?: number;
  attempts?: number;
  /** Extra veto, e.g. the phone viewer. */
  suppress?: () => boolean;
}

export function initCommunityHint(opts: CommunityHintOptions = {}): void {
  const { doc = document, delay = 25_000, retry = 15_000, attempts = 8, suppress } = opts;
  const storage = prefsStorage;
  if (!shouldShowCommunityHint(recordStart(storage))) return;

  let left = attempts;
  const tryShow = () => {
    if (readCommunityHint(storage).closed) return;
    const busy = suppress?.() || doc.querySelector(BLOCKING) || doc.visibilityState === 'hidden';
    if (busy) { if (--left > 0) setTimeout(tryShow, retry); return; }
    show();
  };
  setTimeout(tryShow, delay);

  function show() {
    const card = doc.createElement('aside');
    card.className = 'community-hint';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-label', 'SignaVis community');
    card.innerHTML = `
      <span class="community-hint__icon" aria-hidden="true">${MessagesSquare}</span>
      <div class="community-hint__body">
        <strong>SignaVis community</strong>
        <span>Questions, ideas and recordings on Telegram.</span>
      </div>
      <a class="community-hint__join" href="${COMMUNITY_URL}" target="_blank" rel="noopener noreferrer">Join</a>
      <button type="button" class="community-hint__close" aria-label="Dismiss" title="Don't show again">${X}</button>`;
    const close = () => {
      writeCommunityHint(storage, { ...readCommunityHint(storage), closed: true });
      card.classList.remove('is-open');
      setTimeout(() => card.remove(), 250);
    };
    card.querySelector('.community-hint__join')?.addEventListener('click', close);
    card.querySelector('.community-hint__close')?.addEventListener('click', close);
    doc.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('is-open'));
  }
}
