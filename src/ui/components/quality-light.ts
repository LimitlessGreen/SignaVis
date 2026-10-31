// Xeno-canto-style quality "traffic light": five A–E boxes, the active one filled.

export const QUALITY_COLORS: Record<string, string> = {
  A: '#1e8e3e', B: '#7cb342', C: '#f9a825', D: '#ef6c00', E: '#d32f2f',
};

const QUALITY_TITLES: Record<string, string> = {
  A: 'A – sehr gut', B: 'B – gut', C: 'C – mittel', D: 'D – schwach', E: 'E – schlecht',
};

/** Read-only A–E rating display. Falls back to plain text for unknown values ("no score"). */
export function buildQualityLight(value: unknown): HTMLElement {
  const q = String(value ?? '').trim().toUpperCase();
  const wrap = document.createElement('span');
  if (!QUALITY_COLORS[q]) {
    wrap.textContent = String(value ?? '');
    return wrap;
  }
  wrap.className = 'quality-light';
  wrap.title = `Quality ${QUALITY_TITLES[q]}`;
  wrap.style.cssText = 'display:inline-flex;gap:3px;vertical-align:middle';
  for (const opt of Object.keys(QUALITY_COLORS)) {
    const c = QUALITY_COLORS[opt];
    const on = opt === q;
    const b = document.createElement('span');
    b.textContent = opt;
    b.style.cssText =
      `display:inline-flex;align-items:center;justify-content:center;width:18px;height:16px;` +
      `border-radius:3px;border:1.5px solid ${c};font-size:10px;font-weight:700;line-height:1;` +
      `background:${on ? c : 'transparent'};color:${on ? '#fff' : c};opacity:${on ? 1 : 0.4}`;
    wrap.appendChild(b);
  }
  return wrap;
}
