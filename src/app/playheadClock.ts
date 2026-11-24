/**
 * Playhead clock: turns the media element's coarse, uneven currentTime into an evenly moving
 * playhead position (pixels).
 *
 * The media clock is not trustworthy right after play(): Chromium advances it a few
 * milliseconds, holds it while the audio output starts (~250 ms), then runs. Extrapolating
 * from that first step made the playhead start, stop, then leap ahead. So the clock only
 * extrapolates once it is "locked": a few consecutive raw steps at roughly the expected
 * rate. Until then (and after a stall) the playhead shows the raw position.
 *
 * Locked, it advances at the known rate (pixels per second × playback rate) and is pulled
 * gently toward the raw position, aged by the time since that raw value arrived, so the
 * pull does not tug at every coarse step. It never steps backwards during playback.
 */

/** Raw steps in a row at the expected rate before the clock extrapolates. */
const LOCK_STEPS = 3;
/** A step's rate counts as expected within this ratio (coarse clocks are uneven). */
const RATE_TOLERANCE = 0.5;
/** No raw step for this long while locked: a stall (buffering), hold at the raw value. */
const STALL_MS = 250;
/** Updates further apart than this start a new clock (seek, paused, tab hidden). */
const GAP_MS = 120;
/** Time constant of the pull toward the raw position. */
const PULL_MS = 150;

interface ClockState {
    pos: number;      // shown position (px)
    at: number;       // when pos was computed (ms)
    raw: number;      // last raw position (px)
    rawAt: number;    // when raw changed (ms)
    vel: number;      // px/ms: expected, or estimated without one
    run: number;      // raw steps in a row at the expected rate
    locked: boolean;
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
            this._c = { pos: position, at: now, raw: position, rawAt: now, vel: known ? (expectedVel as number) : 0, run: 0, locked: false };
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
            if (c.run >= LOCK_STEPS && !c.locked) { c.locked = true; c.pos = Math.max(c.pos, position); }
            c.raw = position;
            c.rawAt = now;
        } else if (c.locked && now - c.rawAt > STALL_MS) {
            c.locked = false;
            c.run = 0;
        }

        if (!c.locked) {
            // Starting up or stalled: the raw position, never backwards
            c.pos = Math.max(c.pos, position);
            c.at = now;
            return c.pos;
        }
        const target = c.raw + c.vel * (now - c.rawAt);
        let next = c.pos + c.vel * dt;
        next += (target - next) * (1 - Math.exp(-dt / PULL_MS));
        if (next < c.pos) next = c.pos;
        c.pos = next;
        c.at = now;
        return next;
    }
}
