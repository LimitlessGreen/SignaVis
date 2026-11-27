// ═══════════════════════════════════════════════════════════════════════
// app/lite/top-menus.ts — what the Lite top-bar menus hold (Annotate v2, mockup B3)
//
// "Project ▾" bundles adding recordings, the project folder, label import /
// export and upload; "⚙" holds the app settings. Pure: the entries carry an
// `id`; the app maps ids to actions (main.js), so the contents can be tested
// without a page. Entries follow the context-menu item shape.
// ═══════════════════════════════════════════════════════════════════════

export interface MenuEntry {
    id?: string;
    label?: string;
    heading?: string;
    separator?: boolean;
    hint?: string;
    checked?: boolean;
    more?: boolean;
    danger?: boolean;
    disabled?: boolean;
}

export interface ProjectMenuContext {
    /** Project kind: a folder on disk, or the app's default (browser) project. */
    kind: 'folder' | 'browser' | string;
    /** The project has a catalog (library): recordings are imported there. */
    hasCatalog: boolean;
    /** The microphone can be used (record button available). */
    canRecord: boolean;
    /** Xeno-canto downloads are copied into the project folder. */
    xcToFolder: boolean;
    /** Entries in "Open recent". */
    recentCount: number;
}

export function projectMenu(c: ProjectMenuContext): MenuEntry[] {
    const folder = c.kind === 'folder';
    return [
        { heading: 'Add to project' },
        { id: 'add-file', label: 'Audio file…', hint: 'Ctrl O' },
        ...(c.canRecord ? [{ id: 'record', label: 'Record from microphone…' }] : []),
        { id: 'add-xc', label: 'Xeno-canto recording…', hint: 'XC number or URL' },
        ...(folder ? [{ id: 'catalog-import', label: 'Import recordings to catalog…', hint: 'Browse' }] : []),
        { separator: true },
        { heading: 'Project' },
        { id: 'open-folder', label: 'Open folder…' },
        { id: 'open-recent', label: 'Open recent', more: true, disabled: c.recentCount === 0 },
        ...(folder && c.hasCatalog ? [{ id: 'sites', label: 'Sites & recorders…' }] : []),
        ...(folder ? [
            { id: 'xc-to-folder', label: 'Save XC downloads in folder', checked: c.xcToFolder },
            { id: 'rescan', label: 'Rescan folder' },
        ] : []),
        { separator: true },
        { heading: 'Labels' },
        { id: 'import-labels', label: 'Import labels…', hint: 'Annota JSON' },
        { id: 'export-labels', label: 'Export labels', more: true },
        { id: 'upload', label: 'Upload to Xeno-canto…', hint: 'U' },
        { separator: true },
        { id: 'new-session', label: 'New session…', hint: 'removes recordings + labels', danger: true },
    ];
}

export interface SettingsMenuContext {
    /** Current label language code (e.g. en_uk). */
    language: string;
    hasXcKey: boolean;
    dark: boolean;
}

export function settingsMenu(c: SettingsMenuContext): MenuEntry[] {
    return [
        { heading: 'Settings' },
        { id: 'language', label: 'Label language', hint: c.language, more: true },
        { id: 'xc-key', label: 'Xeno-canto API key', hint: c.hasXcKey ? 'saved ✓' : 'not set' },
        { id: 'theme', label: 'Dark theme', checked: c.dark },
        { id: 'reset-layout', label: 'Reset panel layout', hint: 'this project' },
    ];
}
