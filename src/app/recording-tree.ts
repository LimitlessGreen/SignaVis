// recording-tree.ts — folder tree of a project's recordings (pure, no DOM)
//
// - Recordings with a project path appear in their real sub-folders ('audio/2026/a.wav').
// - XC downloads (source 'xc', no path or a path under 'xc/') go into the virtual folder
//   "Xeno-canto" (id XC_FOLDER_ID), sorted by XC number.
// - Everything else (session-only files, samples, URLs) sits at the root.
// - Audio files of the project folder that have no recording entry yet appear as 'file'
//   nodes in their folders: opening one creates the entry (the project file stays small).
// Folders come first, then recordings; names sort naturally ('a2' before 'a10').

import { inferSource } from '../domain/project/workspaceProject.ts';
import { toXcId, xcNumber } from '../domain/xc/xcId.ts';

export const XC_FOLDER_ID = '@xc';

export interface TreeFolder { kind: 'folder'; id: string; name: string; virtual?: 'xc'; children: TreeNode[] }
export interface TreeRecording { kind: 'recording'; id: string; entry: any }
export interface TreeFile { kind: 'file'; id: string; path: string; name: string; size?: number }
export type TreeNode = TreeFolder | TreeRecording | TreeFile;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const isXcDownload = (entry: any) =>
    inferSource(entry) === 'xc' && (!entry?.path || /^xc\//i.test(entry.path));

/** Display name of a recording row (without folder). */
export function recordingName(entry: any) {
    if (isXcDownload(entry)) return toXcId(entry.xcId) || entry.filename || 'Untitled';
    const p = typeof entry?.path === 'string' ? entry.path : '';
    return (p ? p.slice(p.lastIndexOf('/') + 1) : '') || entry?.filename || 'Untitled';
}

function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
        if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
        if (a.kind === 'folder' && b.kind === 'folder') {
            if (!!a.virtual !== !!b.virtual) return a.virtual ? 1 : -1;   // real folders before Xeno-canto
            return collator.compare(a.name, b.name);
        }
        // Recordings and not-yet-opened files sort together by name, like a file browser
        const ea = a.kind === 'recording' ? a.entry : null, eb = b.kind === 'recording' ? b.entry : null;
        if (ea && eb && isXcDownload(ea) && isXcDownload(eb)) return Number(xcNumber(ea.xcId)) - Number(xcNumber(eb.xcId));
        const na = ea ? recordingName(ea) : (a as TreeFile).name, nb = eb ? recordingName(eb) : (b as TreeFile).name;
        return collator.compare(na, nb);
    });
    for (const n of nodes) if (n.kind === 'folder') sortNodes(n.children);
    return nodes;
}

export function buildRecordingTree(entries: any[], folderFiles: { path: string; size?: number }[] = []): TreeNode[] {
    const root: TreeNode[] = [];
    const folders = new Map<string, TreeFolder>();
    const folder = (id: string, name: string, parent: TreeNode[], virtual?: 'xc') => {
        let f = folders.get(id);
        if (!f) {
            f = { kind: 'folder', id, name, children: [], ...(virtual ? { virtual } : {}) };
            folders.set(id, f);
            parent.push(f);
        }
        return f;
    };
    for (const entry of entries || []) {
        if (!entry) continue;
        const node: TreeRecording = { kind: 'recording', id: entry.id, entry };
        if (isXcDownload(entry)) { folder(XC_FOLDER_ID, 'Xeno-canto', root, 'xc').children.push(node); continue; }
        const dirs = typeof entry.path === 'string' ? entry.path.split('/').slice(0, -1).filter(Boolean) : [];
        let parent = root;
        dirs.forEach((d: string, i: number) => { parent = folder(dirs.slice(0, i + 1).join('/'), d, parent).children; });
        parent.push(node);
    }
    for (const f of folderFiles || []) {
        if (!f?.path) continue;
        const parts = f.path.split('/').filter(Boolean);
        const dirs = parts.slice(0, -1);
        let parent = root;
        dirs.forEach((d: string, i: number) => { parent = folder(dirs.slice(0, i + 1).join('/'), d, parent).children; });
        parent.push({ kind: 'file', id: `file:${f.path}`, path: f.path, name: parts[parts.length - 1] || f.path, size: f.size });
    }
    return sortNodes(root);
}

/** IDs of all folders on the way to a recording (to unfold the active one). */
export function folderPathOf(tree: TreeNode[], recordingId: string): string[] {
    for (const n of tree) {
        if (n.kind !== 'folder') continue;
        const sub = folderPathOf(n.children, recordingId);
        if (sub.length || n.children.some((c) => c.kind === 'recording' && c.id === recordingId)) return [n.id, ...sub];
    }
    return [];
}

export function countRecordings(node: TreeNode): number {
    return node.kind === 'folder' ? node.children.reduce((s, c) => s + countRecordings(c), 0) : 1;
}
