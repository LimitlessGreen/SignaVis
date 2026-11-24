/**
 * Playhead clock: turns the media element's coarse, uneven currentTime into an evenly moving
 * playhead position (pixels).
 *
 * The media clock is not trustworthy right after play(): Chromium and QtWebEngine (the
 * Analyzer's window) advance it in bursts for ~0.3-0.5 s while the audio output starts
 * (a few ms, hold, a leap, hold, ...), then it runs evenly. Showing or extrapolating those
 * bursts made the playhead start, stop, then leap ahead. So the playhead holds still until
 * the clock is "locked" (a few consecutive raw steps at roughly the expected rate).
 *
 * Locked, it moves at the known rate (pixels per second × playback rate), sped up or slowed
 * down by at most half to follow the raw position (aged by the time since that value
 * arrived, at most STALL_MS): it never leaps and never steps backwards; on a stall it
 * slows to a halt and catches up afterwards.
 */

/** Raw steps in a row at the expected rate before the clock extrapolates. */
const LOCK_STEPS = 3;
/** A step's rate counts as expected within this ratio (coarse clocks are uneven). */
const RATE_TOLERANCE = 0.5;
/** Raw extrapolation is capped at this age: a stalled clock lets the playhead halt. */
const STALL_MS = 100;
/** Unlocked this long after the raw clock first moved: lock anyway (odd clocks). */
const LOCK_TIMEOUT_MS = 600;
/** Updates further apart than this start a new clock (seek, paused, tab hidden). */
const GAP_MS = 120;
/** An offset of this many ms of playback changes the speed by 100 % (clamped below). */
const FOLLOW_MS = 100;
/** Speed range relative to the nominal rate while following the raw position. */
const MAX_SPEEDUP = 1.5;
/** Further behind than this (ms of playback): snap instead of catching up. */
const SNAP_MS = 500;

interface ClockState {
    pos: number;          // shown position (px)
    at: number;           // when pos was computed (ms)
    raw: number;          // last raw position (px)
    rawAt: number;        // when raw changed (ms)
    vel: number;          // px/ms: expected, or estimated without one
    run: number;          // raw steps in a row at the expected rate
    locked: boolean;
    movedAt: number;      // when the raw clock first moved (ms), 0 = not yet
}

export class PlayheadClock {
    _c: ClockState | null = null;

    reset() { this._c = null; }

    /**
     * @param position    raw playhead position in pixels
     * @param playing     true while the media plays
     * @param now         performance.now()
     * @param expectedVel pixels per millisecond at the current zoom and playback rate
     * @param maxJump     a raw jump larger than this (px) is a seek: restart
     */
    update(position: number, playing: boolean, now: number, expectedVel?: number, maxJump = Infinity): number {
        const c = this._c;
        if (!playing) { this._c = null; return position; }
        const known = Number.isFinite(expectedVel) && (expectedVel as number) > 0;
        // A raw step backwards is a seek or a loop, never jitter: restart there too
        if (!c || now - c.at > GAP_MS || Math.abs(position - c.raw) > maxJump || position < c.raw - 0.5) {
            this._c = { pos: position, at: now, raw: position, rawAt: now, vel: known ? (expectedVel as number) : 0, run: 0, locked: false, movedAt: 0 };
            return position;
        }
        if (known) c.vel = expectedVel as number;
        const dt = now - c.at;
        if (dt <= 0.5 && position === c.raw) return c.pos;   // same-frame repeat (follow scroll)

        if (position !== c.raw) {
            const span = Math.max(1, now - c.rawAt);
            const rate = (position - c.raw) / span;
            if (!known) c.vel += (rate - c.vel) * (1 - Math.exp(-span / 250));
            const ok = c.vel > 0 && Math.abs(rate / c.vel - 1) <= RATE_TOLERANCE;
            c.run = ok ? c.run + 1 : 0;
            if (!c.movedAt) c.movedAt = now;
            c.raw = position;
            c.rawAt = now;
        }
        if (!c.locked && (c.run >= LOCK_STEPS || (c.movedAt && now - c.movedAt > LOCK_TIMEOUT_MS))) c.locked = true;

        if (!c.locked || c.vel <= 0) {
            // Output starting: hold still where playback started
            c.at = now;
            return c.pos;
        }
        const target = c.raw + c.vel * Math.min(now - c.rawAt, STALL_MS);
        // Offset from where the nominal rate alone would put it this frame
        const err = target - (c.pos + c.vel * dt);
        if (err > c.vel * SNAP_MS) {
            c.pos = target;
        } else {
            const speed = Math.min(MAX_SPEEDUP, Math.max(0, 1 + err / (c.vel * FOLLOW_MS)));
            c.pos += c.vel * dt * speed;
        }
        c.at = now;
        return c.pos;
    }
}
