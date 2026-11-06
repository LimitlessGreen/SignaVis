// ═══════════════════════════════════════════════════════════════════════
// app/recent-items.ts — "Open Recent" list of SignaVis Lite
//
// Local audio files (absolute path) and project folders, newest first,
// kept in localStorage. The Lite shell only renders the list as a menu
// (set_recent_items in src-tauri-lite/src/menu.rs).
// ═══════════════════════════════════════════════════════════════════════

export type RecentItem =
    | { kind: 'file'; path: string }
    | { kind: 'folder'; path: string; name: string };

export const RECENT_KEY = 'signavis.lite.recent.v1';
export const RECENT_MAX = 10;

const lastSegment = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

function isRecentItem(x: any): x is RecentItem {
    return x && typeof x.path === 'string' && x.path
        && (x.kind === 'file' || (x.kind === 'folder' && typeof x.name === 'string'));
}

export function loadRecent(ls: Pick<Storage, 'getItem'> | null | undefined): RecentItem[] {
    try {
        const list = JSON.parse(ls?.getItem(RECENT_KEY) || '[]');
        return Array.isArray(list) ? list.filter(isRecentItem).slice(0, RECENT_MAX) : [];
    } catch { return []; }
}

export function saveRecent(ls: Pick<Storage, 'setItem'> | null | undefined, items: RecentItem[]) {
    try { ls?.setItem(RECENT_KEY, JSON.stringify(items.slice(0, RECENT_MAX))); } catch { /* ignore */ }
}

/** Put `item` first; an existing entry for the same path and kind moves up. */
export function addRecent(items: RecentItem[], item: RecentItem): RecentItem[] {
    const rest = items.filter((i) => !(i.kind === item.kind && samePath(i.path, item.path)));
    return [item, ...rest].slice(0, RECENT_MAX);
}

/** Menu labels: "📁 Feld 2026" for folders, file names for files (parent folder added on clashes). */
export function recentMenuItems(items: RecentItem[]): { id: string; label: string }[] {
    const names = items.map((i) => (i.kind === 'folder' ? i.name : lastSegment(i.path)));
    return items.map((item, n) => {
        const clash = names.filter((x) => x === names[n]).length > 1;
        const parent = lastSegment(item.path.replace(/[\\/][^\\/]*[\\/]?$/, ''));
        const name = clash ? `${names[n]} (${parent})` : names[n];
        return { id: String(n), label: item.kind === 'folder' ? `📁 ${name}` : name };
    });
}
