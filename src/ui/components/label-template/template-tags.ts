// ═══════════════════════════════════════════════════════════════════════
// template-tags.ts — tags of the label template (top bar, next to the species)
//
// A chip showing the template's tags ("male · song", or "+ Tags") that opens
// a small popover with one select per tag list. New labels get these tags
// together with the template's species.
// ═══════════════════════════════════════════════════════════════════════

export interface TagPreset { key: string; label?: string; options: string[] }

export interface TemplateTagsOptions {
    getPresets: () => TagPreset[];
    getTags: () => Record<string, string>;
    onChange: (tags: Record<string, string>) => void;
}

const TITLES: Record<string, string> = { sex: 'Sex', lifeStage: 'Life stage', soundType: 'Sound type' };

/** Chip text: the tag values in preset order, then custom ones. */
export function templateTagsSummary(tags: Record<string, string>, presets: TagPreset[]): string {
    const keys = [...presets.map((p) => p.key), ...Object.keys(tags).filter((k) => !presets.some((p) => p.key === k))];
    return keys.map((k) => tags[k]).filter(Boolean).join(' · ');
}

export function createTemplateTags({ getPresets, getTags, onChange }: TemplateTagsOptions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'template-tags-btn';

    const pop = document.createElement('div');
    pop.className = 'template-tags-pop hidden';
    document.body.appendChild(pop);

    function refresh() {
        const text = templateTagsSummary(getTags(), getPresets());
        btn.textContent = text || '+ Tags';
        btn.classList.toggle('has-tags', !!text);
        btn.title = text
            ? `New labels get: ${text}. Click to change.`
            : 'Tags for new labels (sex, life stage, sound type)';
        if (!pop.classList.contains('hidden')) render();
    }

    function render() {
        const tags = getTags();
        // Rebuilding removes the focused control: remember it and focus its successor
        const focusKey = pop.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
        pop.innerHTML = '';
        const head = document.createElement('div');
        head.className = 'template-tags-head';
        head.textContent = 'Tags for new labels';
        pop.appendChild(head);
        for (const preset of getPresets()) {
            const row = document.createElement('label');
            row.className = 'template-tags-row';
            const name = document.createElement('span');
            name.textContent = TITLES[preset.key] || preset.label || preset.key;
            const sel = document.createElement('select');
            sel.dataset.focusKey = preset.key;
            const cur = tags[preset.key] || '';
            const options = cur && !preset.options.includes(cur) ? [...preset.options, cur] : preset.options;
            for (const v of ['', ...options]) {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = v || '—';
                sel.appendChild(o);
            }
            sel.value = cur;
            sel.addEventListener('change', () => {
                const next = { ...getTags() };
                if (sel.value) next[preset.key] = sel.value; else delete next[preset.key];
                onChange(next);
            });
            row.append(name, sel);
            pop.appendChild(row);
        }
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'template-tags-clear';
        clear.dataset.focusKey = 'clear';
        clear.textContent = 'Clear tags';
        clear.disabled = !Object.keys(tags).length;
        clear.addEventListener('click', () => onChange({}));
        pop.appendChild(clear);
        if (focusKey) [...pop.querySelectorAll<HTMLElement>('[data-focus-key]')].find((el) => el.dataset.focusKey === focusKey && !(el as HTMLButtonElement).disabled)?.focus();
    }

    function place() {
        const r = btn.getBoundingClientRect();
        pop.style.top = `${r.bottom + 4}px`;
        pop.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 4))}px`;
    }

    function open() { pop.classList.remove('hidden'); render(); place(); }
    function close() { pop.classList.add('hidden'); }

    btn.addEventListener('click', () => (pop.classList.contains('hidden') ? open() : close()));
    const onDocDown = (e: Event) => {
        if (!pop.contains(e.target as Node) && !btn.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);

    refresh();
    return {
        el: btn,
        refresh,
        close,
        destroy() {
            pop.remove();
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', close);
        },
    };
}
