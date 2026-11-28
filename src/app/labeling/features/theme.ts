// Theme toggle: light / dark, saved in prefs; without a saved choice the system setting wins.
import { Sun, Moon } from 'lucide-static';
import { prefs } from '../../../infrastructure/storage/prefs.ts';

const KEY = 'aw:theme';

const systemTheme = (): 'light' | 'dark' =>
    (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

export function installThemeToggle(button: HTMLElement | null): void {
    if (!button) return;
    const apply = (theme: string) => {
        document.documentElement.setAttribute('data-theme', theme);
        button.innerHTML = theme === 'light' ? Sun : Moon;
        button.setAttribute('aria-pressed', String(theme === 'light'));
    };
    apply(prefs.get(KEY) || systemTheme());
    button.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || systemTheme();
        const next = current === 'light' ? 'dark' : 'light';
        apply(next);
        prefs.set(KEY, next);
    });
}

// Accent colour: blue is the operating colour (default); amber, the signal colour
// of the spectrogram and the logo, is an optional theme for the dark theme
// (amber turns brown on white). Set as html[data-accent="amber"], colours in _theme-tokens.scss.
const ACCENT_KEY = 'aw:accent';
export type Accent = 'blue' | 'amber';

export function applyAccent(accent: Accent): void {
    if (accent === 'amber') document.documentElement.setAttribute('data-accent', 'amber');
    else document.documentElement.removeAttribute('data-accent');
}

const savedAccent = (): Accent => (prefs.get(ACCENT_KEY) === 'amber' ? 'amber' : 'blue');

export function installAccent(): void {
    applyAccent(savedAccent());
}

/** Settings row for the Display panel. */
export function createAccentSection(): HTMLElement {
    const sec = document.createElement('div');
    sec.className = 'settings-section accent-section';
    sec.innerHTML = `
      <div class="settings-row">
        <label class="settings-label" for="accentSelect">Accent colour</label>
        <select id="accentSelect" class="settings-select">
          <option value="blue">Blue</option>
          <option value="amber">Amber (dark theme)</option>
        </select>
      </div>`;
    const select = sec.querySelector('select')!;
    select.value = savedAccent();
    select.addEventListener('change', (e) => {
        e.stopPropagation(); // not a spectrogram setting: keep it out of the panel's preset hint
        const accent: Accent = select.value === 'amber' ? 'amber' : 'blue';
        applyAccent(accent);
        prefs.set(ACCENT_KEY, accent);
    });
    return sec;
}
