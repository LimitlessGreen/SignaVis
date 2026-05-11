/**
 * AnnotatorProfile — persistent annotator identity for XC upload.
 *
 * Stored in localStorage under 'aw:annotator-profile.v1'.
 * Fires a 'change' CustomEvent on the instance whenever fields update.
 *
 * Fields:
 *   name        — annotator's full name
 *   xcUsername  — Xeno-canto login username
 *   license     — default CC license for annotations
 *   owner       — organisation / person (for set_owner)
 *   onboardingDone — true once the user has filled in name + xcUsername
 */

const STORAGE_KEY = 'aw:annotator-profile.v1';

const DEFAULTS = {
    name: '',
    xcUsername: '',
    license: 'CC BY-NC-SA 4.0',
    owner: '',
    onboardingDone: false,
};

export class AnnotatorProfile extends EventTarget {
    // TypeScript property declarations (migrated from JS)
    _data: any;
    constructor() {
        super();
        this._data = { ...DEFAULTS };
        this._load();
    }

    // ── Getters ─────────────────────────────────────────────────────────

    get name()            { return this._data.name; }
    get xcUsername()      { return this._data.xcUsername; }
    get license()         { return this._data.license; }
    get owner()           { return this._data.owner; }
    get onboardingDone()  { return this._data.onboardingDone; }

    /**
     * Returns true when the minimum required fields (name + xcUsername) are filled in.
     * Used to gate XC upload and dismiss the onboarding banner.
     */
    isComplete() {
        return !!(this._data.name.trim() && this._data.xcUsername.trim());
    }

    // ── Setters ─────────────────────────────────────────────────────────

    set name(v)           { this._set('name', String(v ?? '')); }
    set xcUsername(v)     { this._set('xcUsername', String(v ?? '')); }
    set license(v)        { this._set('license', String(v ?? '')); }
    set owner(v)          { this._set('owner', String(v ?? '')); }
    set onboardingDone(v) { this._set('onboardingDone', Boolean(v)); }

    /**
     * Update multiple fields at once and fire a single 'change' event.
     * @param {Partial<typeof DEFAULTS>} updates
     */
    update(updates: any) {
        let changed = false;
        for (const [k, v] of Object.entries(updates)) {
            if (k in DEFAULTS && this._data[k] !== v) {
                this._data[k] = v;
                changed = true;
            }
        }
        if (changed) {
            this._save();
            this._fire();
        }
    }

    /**
     * Returns a plain object snapshot of the profile, safe to spread into
     * XC upload metadata (creator, xcUsername, license, owner).
     */
    toJSON() {
        return { ...this._data };
    }

    // ── Persistence ──────────────────────────────────────────────────────

    _set(key: any, value: any) {
        if (this._data[key] === value) return;
        this._data[key] = value;
        this._save();
        this._fire();
    }

    _save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
        } catch { /* storage unavailable */ }
    }

    _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                for (const k of Object.keys(DEFAULTS)) {
                    if (k in parsed) this._data[k] = parsed[k];
                }
            }
        } catch { /* ignore parse errors */ }
    }

    _fire() {
        this.dispatchEvent(new CustomEvent('change', { detail: this.toJSON() }));
    }
}
