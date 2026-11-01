// ultrasound-dialog.ts — small popup after an ultrasonic (bat) recording was loaded
//
// Says what was detected and lets the user pick how to listen: heterodyne
// (carrier at the detected peak), time expansion, frequency division, pitch
// shift or the original. Every option can be previewed on an automatically
// found stretch of calls. "Remember" makes the choice the default, so later
// bat recordings switch without asking.

export type UltrasoundChoice = 'heterodyne' | 'expansion' | 'division' | 'pitch' | 'none';

export const ULTRASOUND_DEFAULT_KEY = 'aw.ultrasound.listenDefault';

export function loadUltrasoundDefault(): UltrasoundChoice | null {
    try {
        const v = localStorage.getItem(ULTRASOUND_DEFAULT_KEY);
        return v === 'heterodyne' || v === 'expansion' || v === 'division' || v === 'pitch' || v === 'none' ? v : null;
    } catch { return null; }
}

export function saveUltrasoundDefault(choice: UltrasoundChoice | null): void {
    try {
        if (choice) localStorage.setItem(ULTRASOUND_DEFAULT_KEY, choice);
        else localStorage.removeItem(ULTRASOUND_DEFAULT_KEY);
    } catch { /* storage blocked: the choice just is not remembered */ }
}

export interface UltrasoundDialogOptions {
    host: HTMLElement;
    peakHz: number | null;
    source: 'guano' | 'spectrum' | 'none';
    device: string | null;
    expansion: number;
    divisor: number;
    pitchFactor: number;
    excerpt: { start: number; end: number } | null;
    initial: UltrasoundChoice;
    /** A default is already remembered (checkbox starts ticked; unticking forgets it). */
    remembered: boolean;
    /** Switch playback to this mode (preview and final choice). */
    apply(choice: UltrasoundChoice): void;
    /** Play the excerpt in the current mode. */
    preview(start: number, end: number): void;
    stopPreview(): void;
    /** Dialog closed; `choice` null = dismissed (keep what was there before), `remember` only matters with a choice. */
    onClose(choice: UltrasoundChoice | null, remember: boolean): void;
}

const kHz = (hz: number) => `${(hz / 1000).toFixed(hz < 20000 ? 1 : 0)} kHz`;
const fmtT = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export class UltrasoundDialog {
    readonly el: HTMLElement;
    #o: UltrasoundDialogOptions;
    #choice: UltrasoundChoice;
    #playing: UltrasoundChoice | null = null;
    #keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(null); } };

    constructor(o: UltrasoundDialogOptions) {
        this.#o = o;
        this.#choice = o.initial;
        this.el = document.createElement('div');
        this.el.className = 'us-dialog';
        this.el.setAttribute('role', 'dialog');
        this.el.setAttribute('aria-label', 'Ultrasonic recording detected');
        this.#render();
        o.host.appendChild(this.el);
        document.addEventListener('keydown', this.#keyHandler, true);
        (this.el.querySelector('.us-opt.selected input') as HTMLInputElement | null)?.focus();
    }

    #render() {
        const o = this.#o;
        const peak = o.peakHz != null ? kHz(o.peakHz) : null;
        const carrier = o.peakHz != null ? Math.round(o.peakHz / 1000) * 1000 : 40000;
        const how = o.source === 'guano' ? `bat detector metadata${o.device ? ` (${o.device})` : ''}` : 'the spectrum';
        const opts: { id: UltrasoundChoice; name: string; desc: string }[] = [
            { id: 'heterodyne', name: `Heterodyne at ${kHz(carrier)}`,
              desc: 'Like a field bat detector: real time, calls near the carrier become audible clicks and chirps. Drag the line in the spectrogram to retune.' },
            { id: 'expansion', name: `Time expansion ×${o.expansion}`,
              desc: `Plays ${o.expansion}× slower: all frequencies and call shapes are kept, but takes longer.` },
            { id: 'division', name: `Frequency division ÷${o.divisor}`,
              desc: 'Real time, the whole band divided down — rough sound, nothing missed.' },
            { id: 'pitch', name: `Pitch shift ÷${o.pitchFactor}`,
              desc: 'Real time, pitch lowered with the timing kept.' },
            { id: 'none', name: 'Original', desc: 'No conversion — ultrasound stays inaudible.' },
        ];
        const ex = o.excerpt;
        this.el.innerHTML = `
            <div class="us-head">
                <span class="us-icon" aria-hidden="true">🦇</span>
                <div class="us-title">
                    <strong>Ultrasonic recording detected</strong>
                    <span>${peak ? `Calls around ${peak}, ` : ''}recognised from ${how}. How do you want to listen?</span>
                </div>
                <button type="button" class="us-x" title="Close (Esc)" aria-label="Close">×</button>
            </div>
            <div class="us-opts" role="radiogroup"></div>
            <div class="us-foot">
                <span class="us-excerpt">${ex ? `▶ previews ${fmtT(ex.start)}–${fmtT(ex.end)} (loudest calls)` : ''}</span>
                <label class="us-remember"><input type="checkbox"${o.remembered ? ' checked' : ''}> Use for all ultrasonic recordings</label>
                <div class="us-actions">
                    <button type="button" class="us-later">Not now</button>
                    <button type="button" class="us-apply">Apply</button>
                </div>
            </div>`;
        const list = this.el.querySelector('.us-opts')!;
        for (const opt of opts) {
            const row = document.createElement('label');
            row.className = 'us-opt';
            row.dataset.choice = opt.id;
            row.innerHTML = `
                <input type="radio" name="us-choice" value="${opt.id}">
                <span class="us-opt-text"><span class="us-opt-name"></span><span class="us-opt-desc"></span></span>
                ${ex ? '<button type="button" class="us-play" title="Preview">▶</button>' : ''}`;
            row.querySelector('.us-opt-name')!.textContent = opt.name + (opt.id === 'heterodyne' ? '  · recommended' : '');
            row.querySelector('.us-opt-desc')!.textContent = opt.desc;
            const radio = row.querySelector('input')!;
            radio.addEventListener('change', () => { if (radio.checked) this.#select(opt.id); });
            row.querySelector('.us-play')?.addEventListener('click', (e) => {
                e.preventDefault();
                this.#togglePreview(opt.id);
            });
            list.appendChild(row);
        }
        this.el.querySelector('.us-x')!.addEventListener('click', () => this.close(null));
        this.el.querySelector('.us-later')!.addEventListener('click', () => this.close(null));
        this.el.querySelector('.us-apply')!.addEventListener('click', () => this.close(this.#choice));
        this.#sync();
    }

    #select(id: UltrasoundChoice) {
        this.#choice = id;
        if (this.#playing && this.#playing !== id) this.#togglePreview(id);
        this.#sync();
    }

    #togglePreview(id: UltrasoundChoice) {
        const ex = this.#o.excerpt;
        if (!ex) return;
        if (this.#playing === id) {
            this.#o.stopPreview();
            this.#playing = null;
        } else {
            this.#choice = id;
            this.#o.apply(id);
            // Time expansion stretches the excerpt: play less of it.
            const len = id === 'expansion' ? Math.min(ex.end - ex.start, 6 / Math.max(1, this.#o.expansion)) : ex.end - ex.start;
            this.#o.preview(ex.start, ex.start + len);
            this.#playing = id;
        }
        this.#sync();
    }

    /** Playback finished or was stopped elsewhere. */
    previewEnded() {
        this.#playing = null;
        this.#sync();
    }

    #sync() {
        for (const row of this.el.querySelectorAll<HTMLElement>('.us-opt')) {
            const id = row.dataset.choice as UltrasoundChoice;
            row.classList.toggle('selected', id === this.#choice);
            (row.querySelector('input') as HTMLInputElement).checked = id === this.#choice;
            const play = row.querySelector('.us-play');
            if (play) {
                play.textContent = this.#playing === id ? '■' : '▶';
                play.setAttribute('title', this.#playing === id ? 'Stop preview' : 'Preview');
            }
        }
    }

    close(choice: UltrasoundChoice | null) {
        if (!this.el.isConnected) return;
        document.removeEventListener('keydown', this.#keyHandler, true);
        if (this.#playing) this.#o.stopPreview();
        const remember = !!(this.el.querySelector('.us-remember input') as HTMLInputElement | null)?.checked;
        this.el.remove();
        this.#o.onClose(choice, remember);
    }
}
