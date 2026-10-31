// ui/panels/project-location.ts — "where is this project stored" block in the Project tab
//
// Pure view: the app passes a view model to render() and gets callbacks.
// Browser project (OPFS) ↔ project folder (File System Access, Chromium).

export interface ProjectLocationView {
    kind: 'browser' | 'folder' | 'none';
    label: string;
    status: string;               // 'saved' | 'saving' | 'pending' | 'error' | 'readonly' | 'conflict' | ''
    folderSupported: boolean;
    recentFolder: string | null;  // name of a remembered folder that needs a click to reopen
    xcToFolder: boolean;
    unadded: { path: string; size: number }[];
    scanning: boolean;
}

export interface ProjectLocationCallbacks {
    onOpenFolder(): void;
    onReopenRecent(): void;
    onUseBrowserProject(): void;
    onToggleXcToFolder(on: boolean): void;
    onAddFiles(paths: string[]): void;
    onRescan(): void;
}

const STATUS_TEXT: Record<string, string> = {
    saved: 'Saved',
    saving: 'Saving…',
    pending: 'Unsaved changes…',
    error: 'Save failed — retrying on next change',
    readonly: 'Read-only (open in another tab)',
    conflict: 'Changed outside — waiting for your decision',
};

const fmtSize = (b: number) => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
}

export class ProjectLocationPanel {
    readonly root: HTMLElement;
    #cb: ProjectLocationCallbacks;
    #showAll = false;

    constructor(mount: HTMLElement, callbacks: ProjectLocationCallbacks) {
        this.root = mount;
        this.root.classList.add('project-location');
        this.#cb = callbacks;
    }

    render(v: ProjectLocationView) {
        const r = this.root;
        r.innerHTML = '';

        const line = el('div', 'pl-line');
        const icon = el('span', `pl-kind pl-kind-${v.kind}`, v.kind === 'folder' ? '📁' : '🌐');
        icon.setAttribute('aria-hidden', 'true');
        const name = el('span', 'pl-name', v.kind === 'none' ? 'This session only' : v.label);
        name.title = v.kind === 'folder'
            ? 'Project folder on your computer — project.signavis.json + audio'
            : v.kind === 'browser' ? 'Stored privately in this browser' : 'Not saved (browser storage unavailable)';
        line.append(icon, name);
        if (v.status && STATUS_TEXT[v.status]) {
            line.append(el('span', `pl-status pl-status-${v.status}`, STATUS_TEXT[v.status]));
        }
        r.append(line);

        const actions = el('div', 'pl-actions');
        if (v.folderSupported) {
            const open = el('button', 'sidebar-action-btn secondary', v.kind === 'folder' ? 'Other folder…' : 'Open folder…');
            open.type = 'button';
            open.title = 'Use a folder on your computer as project: labels are saved there, audio files in it can be added';
            open.addEventListener('click', () => this.#cb.onOpenFolder());
            actions.append(open);
            if (v.recentFolder && v.kind !== 'folder') {
                const re = el('button', 'sidebar-action-btn', `Reopen “${v.recentFolder}”`);
                re.type = 'button';
                re.title = 'The browser asks once more for access to this folder';
                re.addEventListener('click', () => this.#cb.onReopenRecent());
                actions.prepend(re);
            }
            if (v.kind === 'folder') {
                const back = el('button', 'link-btn', 'Use browser project');
                back.type = 'button';
                back.addEventListener('click', () => this.#cb.onUseBrowserProject());
                actions.append(back);
            }
        }
        if (actions.childElementCount) r.append(actions);
        if (!v.folderSupported) {
            r.append(el('p', 'field-hint', 'Project folders need Chrome or Edge on a desktop computer. Labels are kept in this browser.'));
        }

        if (v.kind !== 'folder') return;

        const xc = el('label', 'pl-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = v.xcToFolder;
        box.addEventListener('change', () => this.#cb.onToggleXcToFolder(box.checked));
        xc.append(box, document.createTextNode(' Save XC downloads in folder (xc/)'));
        r.append(xc);

        const head = el('div', 'pl-unadded-head');
        const txt = v.scanning ? 'Scanning folder…'
            : v.unadded.length ? `${v.unadded.length} audio file${v.unadded.length === 1 ? '' : 's'} not in project`
            : 'All audio files in the folder are in the project.';
        head.append(el('span', '', txt));
        const rescan = el('button', 'link-btn', 'Rescan');
        rescan.type = 'button';
        rescan.addEventListener('click', () => this.#cb.onRescan());
        head.append(rescan);
        if (v.unadded.length > 1) {
            const all = el('button', 'link-btn', 'Add all');
            all.type = 'button';
            all.addEventListener('click', () => this.#cb.onAddFiles(v.unadded.map((f) => f.path)));
            head.append(all);
        }
        r.append(head);

        if (!v.unadded.length) return;
        const list = el('ul', 'pl-unadded');
        const shown = this.#showAll ? v.unadded : v.unadded.slice(0, 8);
        for (const f of shown) {
            const li = el('li');
            const add = el('button', 'pl-add', '+');
            add.type = 'button';
            add.title = `Add ${f.path} to the project`;
            add.addEventListener('click', () => this.#cb.onAddFiles([f.path]));
            const p = el('span', 'pl-path', f.path);
            p.title = f.path;
            li.append(add, p, el('span', 'pl-size', fmtSize(f.size)));
            list.append(li);
        }
        r.append(list);
        if (v.unadded.length > shown.length) {
            const more = el('button', 'link-btn', `Show all ${v.unadded.length}`);
            more.type = 'button';
            more.addEventListener('click', () => { this.#showAll = true; this.render(v); });
            r.append(more);
        }
    }
}
