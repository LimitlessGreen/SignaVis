// Sponsor card next to the brand: opens on hover (tap on touch), plays a
// small reward animation and remembers a self-reported "I sponsored" so the
// heart stays golden. GitHub does not tell us who sponsors, so we ask once
// after the user comes back from the sponsor page.

export const SPONSOR_STORAGE_KEY = 'signavis.sponsor';

export type SponsorState = 'none' | 'pending' | 'sponsor';

export function readSponsorState(storage: Pick<Storage, 'getItem'> | null): SponsorState {
  try {
    const v = storage?.getItem(SPONSOR_STORAGE_KEY);
    return v === 'pending' || v === 'sponsor' ? v : 'none';
  } catch {
    return 'none';
  }
}

export function writeSponsorState(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, state: SponsorState): void {
  try {
    if (state === 'none') storage?.removeItem(SPONSOR_STORAGE_KEY);
    else storage?.setItem(SPONSOR_STORAGE_KEY, state);
  } catch { /* private mode etc. */ }
}

/** Which view the card shows for a given state. */
export function viewForState(state: SponsorState): 'ask' | 'confirm' | 'thanks' {
  if (state === 'sponsor') return 'thanks';
  if (state === 'pending') return 'confirm';
  return 'ask';
}

const SHOW_DELAY = 180;
const HIDE_DELAY = 220;
const BURST_COOLDOWN = 1200;

export function initSponsorCard(doc: Document = document): void {
  const brand = doc.querySelector<HTMLElement>('.brand');
  const card = doc.querySelector<HTMLElement>('.sponsor-card');
  const heart = doc.querySelector<HTMLElement>('.heart-link');
  if (!brand || !card || !heart) return;
  const win = doc.defaultView ?? window;
  const storage = (() => { try { return win.localStorage; } catch { return null; } })();
  const reducedMotion = () => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  let state = readSponsorState(storage);
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let lastBurst = 0;
  let open = false;
  let holdUntil = 0; // keep the card up briefly after the thank-you

  const applyState = () => {
    card.dataset.view = viewForState(state);
    brand.classList.toggle('is-sponsor', state === 'sponsor');
  };
  applyState();

  const setOpen = (next: boolean) => {
    if (open === next) return;
    open = next;
    brand.classList.toggle('is-active', next);
    card.classList.toggle('is-open', next);
    if (next) burst(state === 'sponsor' ? 10 : 7);
  };
  const scheduleShow = () => {
    clearTimeout(hideTimer);
    showTimer = setTimeout(() => setOpen(true), SHOW_DELAY);
  };
  const scheduleHide = () => {
    clearTimeout(showTimer);
    const wait = Math.max(HIDE_DELAY, holdUntil - Date.now());
    hideTimer = setTimeout(() => setOpen(false), wait);
  };

  function burst(count: number, spread = 1) {
    if (reducedMotion()) return;
    const now = Date.now();
    if (now - lastBurst < BURST_COOLDOWN && spread === 1) return;
    lastBurst = now;
    const r = heart!.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let i = 0; i < count; i++) {
      const p = doc.createElement('span');
      p.className = 'sponsor-particle';
      p.textContent = i % 3 === 2 ? '✦' : '♥';
      // fan out to the right/down — the heart sits at the top-left edge
      const angle = (Math.PI / 8) + (Math.random() - 0.5) * Math.PI * Math.min(1.9, 1.1 * spread);
      const dist = (26 + Math.random() * 26) * spread;
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;
      p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
      p.style.setProperty('--rot', `${(Math.random() - 0.5) * 70}deg`);
      p.style.setProperty('--s', `${0.6 + Math.random() * 0.6}`);
      p.style.animationDelay = `${i * 25}ms`;
      doc.body.appendChild(p);
      p.addEventListener('animationend', () => p.remove(), { once: true });
      setTimeout(() => p.remove(), 1600);
    }
  }

  // Hover (mouse / pen)
  for (const el of [brand, card]) {
    el.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') scheduleShow(); });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') scheduleHide(); });
  }
  // Touch: first tap on the heart opens the card instead of navigating
  heart.addEventListener('click', (e) => {
    if ((e as PointerEvent).pointerType === 'touch' && !open) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (state === 'none') { state = 'pending'; writeSponsorState(storage, state); applyState(); }
  });
  doc.addEventListener('pointerdown', (e) => {
    if (open && !brand.contains(e.target as Node) && !card.contains(e.target as Node)) setOpen(false);
  });
  // Keyboard
  brand.addEventListener('focusin', () => setOpen(true));
  card.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (!to || (!card.contains(to) && !brand.contains(to))) scheduleHide();
  });
  brand.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (!to || (!card.contains(to) && !brand.contains(to))) scheduleHide();
  });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });

  // Spotlight follows the cursor
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });

  // Sponsor click → ask once the user returns
  card.querySelector('[data-sponsor-cta]')?.addEventListener('click', () => {
    if (state === 'sponsor') return;
    state = 'pending';
    writeSponsorState(storage, state);
    applyState();
  });
  card.querySelector('[data-sponsor-yes]')?.addEventListener('click', () => {
    state = 'sponsor';
    writeSponsorState(storage, state);
    applyState();
    holdUntil = Date.now() + 2200;
    burst(22, 1.8);
  });
  card.querySelector('[data-sponsor-no]')?.addEventListener('click', () => {
    state = 'none';
    writeSponsorState(storage, state);
    applyState();
    setOpen(false);
  });
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible' && state === 'pending') {
      open = false;
      setOpen(true);
    }
  });
}
