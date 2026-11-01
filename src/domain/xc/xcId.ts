// domain/xc/xcId.ts — canonical Xeno-canto recording IDs
//
// Recordings always store their XC link as 'XC<digits>' (e.g. 'XC928094'):
// a bare number is not recognisable as an XC reference once it leaves its context.
// The bare number is only produced at the API boundary (Annota `xc_nr`, API/download URLs)
// via xcNumber().

/**
 * Canonical form 'XC123' or null.
 * Accepts 123, '123', 'XC 0123', 'xc123', 'https://xeno-canto.org/123(/download)'.
 * Rejects text with other characters (e.g. 'abc', '12a') — use for user input and stored values.
 */
export function toXcId(raw: unknown): string | null {
    if (raw == null) return null;
    let s = String(raw).trim();
    const url = /xeno-canto\.org\/(\d+)/i.exec(s);
    if (url) s = url[1];
    s = s.replace(/^xc\s*/i, '');
    if (!/^\d+$/.test(s)) return null;
    const n = s.replace(/^0+/, '');
    return n ? `XC${n}` : null;
}

/** Bare number ('123') for APIs and the Annota `xc_nr` field; '' when not an XC ID. */
export function xcNumber(raw: unknown): string {
    return toXcId(raw)?.slice(2) ?? '';
}

export const isXcId = (raw: unknown) => toXcId(raw) !== null;

/** Same XC recording? Compares canonical forms; false when either is not an XC ID. */
export function sameXcId(a: unknown, b: unknown): boolean {
    const x = toXcId(a);
    return x !== null && x === toXcId(b);
}
