/**
 * Fill the spectrogram loading overlay (see template.ts `.recomputing-overlay`).
 * progress: 0..1 → determinate bar, null → indeterminate bar, undefined → no bar.
 */
export function setOverlayContent(
    overlay: HTMLElement,
    text: string,
    { detail = '', progress }: { detail?: string; progress?: number | null } = {},
): void {
    const textEl = overlay.querySelector<HTMLElement>('.recomputing-text');
    const detailEl = overlay.querySelector<HTMLElement>('.recomputing-detail');
    const barEl = overlay.querySelector<HTMLElement>('.recomputing-progress');
    const fillEl = barEl?.querySelector<HTMLElement>('.recomputing-progress-fill');

    if (textEl) textEl.textContent = text;
    if (detailEl) {
        detailEl.textContent = detail;
        detailEl.hidden = !detail;
    }
    if (barEl && fillEl) {
        barEl.hidden = progress === undefined;
        barEl.classList.toggle('indeterminate', progress === null);
        fillEl.style.width = typeof progress === 'number'
            ? `${(Math.max(0, Math.min(1, progress)) * 100).toFixed(1)}%`
            : '';
    }
}
