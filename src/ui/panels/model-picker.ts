/**
 * Model picker: a segmented control in front of the BirdNET model preset select.
 * The select (and the URL field) stay the source of truth for BirdNETPanel; this only
 * makes every model version visible and one click away. The URL field shows for "Custom".
 */
export function initModelPicker(opts: {
  seg: HTMLElement | null;
  select: HTMLSelectElement | null;
  urlInput: HTMLInputElement | null;
  note?: HTMLElement | null;
}): () => void {
  const { seg, select, urlInput, note } = opts;
  if (!seg || !select) return () => {};
  const btns = [...seg.querySelectorAll<HTMLButtonElement>('.seg-btn')];
  const sync = (keepUrl = false) => {
    for (const b of btns) {
      const on = b.dataset.value === select.value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && note) note.textContent = b.dataset.note || '';
    }
    if (urlInput && !keepUrl) urlInput.hidden = select.value !== 'custom';
  };
  const pick = (b: HTMLButtonElement, focus = false) => {
    if (select.value !== b.dataset.value) {
      select.value = b.dataset.value || '';
      select.dispatchEvent(new Event('change'));
    }
    sync();
    if (focus) b.focus();
    if (select.value === 'custom') urlInput?.focus();
  };
  btns.forEach((b, i) => {
    b.addEventListener('click', () => pick(b));
    b.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      pick(btns[(i + step + btns.length) % btns.length], true);
    });
  });
  select.addEventListener('change', () => sync(document.activeElement === urlInput));
  // Typing a URL re-detects the preset in BirdNETPanel (its listener runs first);
  // the field stays visible while the user is still editing it
  urlInput?.addEventListener('input', () => sync(true));
  urlInput?.addEventListener('blur', () => sync());
  sync();
  return () => sync();
}
