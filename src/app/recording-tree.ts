// recording-tree.ts — folder tree of a project's recordings (pure, no DOM)
//
// Top level = sources, all as folders on the same level:
// - LOCAL_FOLDER_ID: the project folder (named after it); recordings with a project path in their
//   real sub-folders ('audio/2026/a.wav');
// - XC_FOLDER_ID "Xeno-canto": XC downloads (source 'xc', no path or a path under 'xc/'), by number;
// - SESSION_FOLDER_ID "Session files": everything else (session-only files, samples, URLs).
// - Audio files of the project folder that have no recording entry yet appear as 'file'
//   nodes in their folders: opening one creates the entry (the project file stays small).
// Folders come first, then recordings; names sort naturally ('a2' before 'a10').

import { inferSource } from '../domain/project/workspaceProject.ts';
import { toXcId, xcNumber } from '../domain/xc/xcId.ts';

export const XC_FOLDER_ID = '@xc';
export const LOCAL_FOLDER_ID = '@local';
export const SESSION_FOLDER_ID = '@session';

export interface TreeFolder { kind: 'folder'; id: string; name: string; virtual?: 'xc' | 'local' | 'session'; children: TreeNode[] }
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
            const rank = (f: TreeFolder) => ({ local: 0, xc: 1, session: 2 } as any)[f.virtual || ''] ?? -1;
            if (rank(a) !== rank(b)) return rank(a) - rank(b);   // sub-folders, then local, XC, session
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

export function buildRecordingTree(
    entries: any[],
    folderFiles: { path: string; size?: number }[] = [],
    { localName = 'Project folder' }: { localName?: string } = {},
): TreeNode[] {
    const root: TreeNode[] = [];
    const folders = new Map<string, TreeFolder>();
    const folder = (id: string, name: string, parent: TreeNode[], virtual?: TreeFolder['virtual']) => {
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
        if (typeof entry.path !== 'string' || !entry.path) {
            folder(SESSION_FOLDER_ID, 'Session files', root, 'session').children.push(node);
            continue;
        }
        const dirs = entry.path.split('/').slice(0, -1).filter(Boolean);
        let parent = folder(LOCAL_FOLDER_ID, localName, root, 'local').children;
        dirs.forEach((d: string, i: number) => { parent = folder(dirs.slice(0, i + 1).join('/'), d, parent).children; });
        parent.push(node);
    }
    for (const f of folderFiles || []) {
        if (!f?.path) continue;
        const parts = f.path.split('/').filter(Boolean);
        const dirs = parts.slice(0, -1);
        let parent = folder(LOCAL_FOLDER_ID, localName, root, 'local').children;
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

/** Folder of a recording for grouping (same ids as the tree): sub-folder path, '' = project folder root. */
export function recordingFolder(entry: any): string {
    if (isXcDownload(entry)) return XC_FOLDER_ID;
    if (typeof entry?.path !== 'string' || !entry.path) return SESSION_FOLDER_ID;
    const i = entry.path.lastIndexOf('/');
    return i > 0 ? entry.path.slice(0, i) : '';
}

/** All recordings and never-opened files below a folder node (any depth). */
export function folderContents(node: TreeNode): { entries: any[]; files: TreeFile[] } {
    const out = { entries: [] as any[], files: [] as TreeFile[] };
    const walk = (n: TreeNode) => {
        if (n.kind === 'recording') out.entries.push(n.entry);
        else if (n.kind === 'file') out.files.push(n);
        else n.children.forEach(walk);
    };
    walk(node);
    return out;
}
