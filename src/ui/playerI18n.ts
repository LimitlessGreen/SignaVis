// Language of the player's own UI (option `locale`). The UI is written in
// English; another language is a file in src/locales mapping the English text
// to the translation, applied to the player's DOM and to everything written into it
// later. Text without an entry stays English, so a missing translation shows
// the English original rather than a key.

import de from '../locales/de.json' with { type: 'json' };

// A locale file holds `text` (English text → translation) and `patterns`
// ([regex source, translation]) for text with numbers in it; {1}, {2} … in
// the translation stand for the regex groups.
interface LocaleFile { text: Record<string, string>; patterns: [string, string][] }
interface Translation { text: Record<string, string>; patterns: [RegExp, string][] }

const compile = (file: LocaleFile): Translation => ({
    text: file.text,
    patterns: file.patterns.map(([re, out]) => [new RegExp(re), out]),
});

const TRANSLATIONS: Record<string, Translation> = { de: compile(de as unknown as LocaleFile) };

/** The translation for a locale such as "de", "de-DE" or "de_AT"; null for English or one without a dictionary. */
export function translationFor(locale: unknown): Translation | null {
    const lang = String(locale || '').toLowerCase().split(/[-_]/)[0];
    return TRANSLATIONS[lang] ?? null;
}

/** `text` in the language of `tr`, or null when there is no translation for it. */
export function translateText(tr: Translation, text: string): string | null {
    const key = text.trim();
    if (!key) return null;
    let out = tr.text[key];
    if (out == null) {
        for (const [re, template] of tr.patterns) {
            const m = re.exec(key);
            if (m) { out = template.replace(/\{(\d+)\}/g, (_, i) => m[+i] ?? ''); break; }
        }
    }
    if (out == null || out === key) return null;
    return text.replace(key, () => out!);
}

const ATTRS = ['title', 'aria-label', 'placeholder'];
// Label names are data, not UI text (attributes are still
// translated: a label's tooltip ends in UI text).
const SKIP = '.spectrogram-label-region, .annotation-region, .overview-label-row-name, [data-aw="fileInfo"] .statusbar-label';

function translateNode(tr: Translation, node: Node) {
    if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP)) return;
        const next = translateText(tr, node.textContent || '');
        if (next != null) node.textContent = next;
        return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    for (const a of ATTRS) {
        const v = el.getAttribute(a);
        const next = v && translateText(tr, v);
        if (next != null && next !== v) el.setAttribute(a, next);
    }
}

function translateTree(tr: Translation, root: Node) {
    translateNode(tr, root);
    const doc = root.ownerDocument || (root as Document);
    const walker = doc.createTreeWalker(root, 1 | 4);   // elements and text
    for (let n = walker.nextNode(); n; n = walker.nextNode()) translateNode(tr, n);
}

/**
 * Translates the player UI under `root` into `locale` and keeps translating
 * what is written into it later. Returns the function that stops it.
 */
export function installPlayerTranslation(root: HTMLElement, locale: unknown): () => void {
    const tr = translationFor(locale);
    if (!tr || typeof MutationObserver === 'undefined') return () => {};
    translateTree(tr, root);
    const observer = new MutationObserver((records) => {
        for (const r of records) {
            if (r.type === 'childList') r.addedNodes.forEach((n) => translateTree(tr, n));
            else translateNode(tr, r.target);
        }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    return () => observer.disconnect();
}
