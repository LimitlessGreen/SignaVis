/**
 * Frequency band to bandpass a label's playback with, or null when the label has none.
 * Full-band labels carry numeric bounds after normalization (0 … Nyquist) but no real band.
 */
export function labelPlaybackBand(label: {
  freqMin?: number | null;
  freqMax?: number | null;
  fullBand?: boolean;
}): { lo: number; hi: number } | null {
  if (label.fullBand) return null;
  const lo = label.freqMin ?? 0;
  const hi = label.freqMax ?? 0;
  return hi > lo ? { lo, hi } : null;
}
