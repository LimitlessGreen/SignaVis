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

    constructor(mount: HTMLElement, callbacks: ProjectLocationCallbacks) {
        this.root = mount;
        this.root.classList.add('project-location');
        this.#cb = callbacks;
    }

    render(v: ProjectLocationView) {
        const r = this.root;
        r.innerHTML = '';
        r.dataset.kind = v.kind;

        // ── Identity: where the project lives + save status ──
        const head = el('div', 'pl-head');
        const icon = el('span', `pl-kind pl-kind-${v.kind}`, v.kind === 'folder' ? '📁' : v.kind === 'browser' ? '🌐' : '⚠');
        icon.setAttribute('aria-hidden', 'true');
        const text = el('div', 'pl-text');
        const name = el('span', 'pl-name', v.kind === 'none' ? 'This session only' : v.label);
        const sub = el('span', 'pl-sub', v.kind === 'folder' ? 'Folder · labels + audio as files'
            : v.kind === 'browser' ? 'In this browser only'
            : 'Not saved — browser storage unavailable');
        name.title = v.kind === 'folder'
            ? 'Project folder on your computer — project.signavis.json + audio'
            : v.kind === 'browser' ? 'Stored privately in this browser' : 'Not saved (browser storage unavailable)';
        text.append(name, sub);
        head.append(icon, text);
        if (v.status && STATUS_TEXT[v.status]) {
            const st = el('span', `pl-status pl-status-${v.status}`, STATUS_TEXT[v.status]);
            st.setAttribute('aria-live', 'polite');
            head.append(st);
        }
        r.append(head);

        const button = (cls: string, label: string, title: string, on: () => void) => {
            const b = el('button', cls, label);
            b.type = 'button';
            if (title) b.title = title;
            b.addEventListener('click', on);
            return b;
        };

        // ── Browser project: recommend a project folder (Chromium only) ──
        if (v.kind !== 'folder') {
            if (!v.folderSupported) {
                r.append(el('p', 'pl-note', 'Project folders need Chrome or Edge on a desktop computer. Labels are kept in this browser.'));
                return;
            }
            const tip = el('div', 'pl-recommend');
            tip.append(el('p', 'pl-recommend-text',
                'Recommended: keep the project in a folder — labels, XC downloads and your own audio stay together as files.'));
            const acts = el('div', 'pl-actions');
            if (v.recentFolder) {
                acts.append(button('sidebar-action-btn', `Reopen “${v.recentFolder}”`,
                    'The browser asks once more for access to this folder', () => this.#cb.onReopenRecent()));
                acts.append(button('link-btn', 'Other folder…', '', () => this.#cb.onOpenFolder()));
            } else {
                acts.append(button('sidebar-action-btn', 'Choose project folder…',
                    'Use a folder on your computer as project: labels are saved there, audio files in it can be added',
                    () => this.#cb.onOpenFolder()));
            }
            tip.append(acts);
            r.append(tip);
            return;
        }

        // ── Project folder: options + folder scan ──
        const opts = el('div', 'pl-folder-opts');
        const xc = el('label', 'pl-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = v.xcToFolder;
        box.addEventListener('change', () => this.#cb.onToggleXcToFolder(box.checked));
        xc.append(box, document.createTextNode(' Save XC downloads in folder (xc/)'));
        opts.append(xc);

        // The folder's audio files are listed in the recordings tree (click opens) — only count + rescan here
        const scan = el('div', 'pl-unadded-head');
        const txt = v.scanning ? 'Scanning folder…'
            : v.unadded.length ? `${v.unadded.length} audio file${v.unadded.length === 1 ? '' : 's'} not opened yet (dimmed below)`
            : 'All audio files of the folder are open.';
        scan.append(el('span', '', txt));
        scan.append(button('link-btn', 'Rescan', 'Look for new audio files in the folder', () => this.#cb.onRescan()));
        opts.append(scan);

        const switches = el('div', 'pl-switch');
        switches.append(button('link-btn', 'Other folder…', 'Open or create another project folder', () => this.#cb.onOpenFolder()));
        switches.append(button('link-btn', 'Use browser storage', 'Switch to the project stored in this browser', () => this.#cb.onUseBrowserProject()));
        opts.append(switches);
        r.append(opts);
    }
}
