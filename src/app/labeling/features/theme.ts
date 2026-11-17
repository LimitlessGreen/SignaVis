// Theme toggle: light / dark, saved in localStorage; without a saved choice the system setting wins.
import { Sun, Moon } from 'lucide-static';

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
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
    apply(saved || systemTheme());
    button.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || systemTheme();
        const next = current === 'light' ? 'dark' : 'light';
        apply(next);
        try { localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
    });
}
