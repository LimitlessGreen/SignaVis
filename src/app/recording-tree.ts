// recording-tree.ts — folder tree of a project's recordings (pure, no DOM)
//
// - Recordings with a project path appear in their real sub-folders ('audio/2026/a.wav').
// - XC downloads (source 'xc', no path or a path under 'xc/') go into the virtual folder
//   "Xeno-canto" (id XC_FOLDER_ID), sorted by XC number.
// - Everything else (session-only files, samples, URLs) sits at the root.
// Folders come first, then recordings; names sort naturally ('a2' before 'a10').

import { inferSource } from '../domain/project/workspaceProject.ts';
import { toXcId, xcNumber } from '../domain/xc/xcId.ts';

export const XC_FOLDER_ID = '@xc';

export interface TreeFolder { kind: 'folder'; id: string; name: string; virtual?: 'xc'; children: TreeNode[] }
export interface TreeRecording { kind: 'recording'; id: string; entry: any }
export type TreeNode = TreeFolder | TreeRecording;

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
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
        if (a.kind === 'folder' && b.kind === 'folder') {
            if (!!a.virtual !== !!b.virtual) return a.virtual ? 1 : -1;   // real folders before Xeno-canto
            return collator.compare(a.name, b.name);
        }
        const ea = (a as TreeRecording).entry, eb = (b as TreeRecording).entry;
        if (isXcDownload(ea) && isXcDownload(eb)) return Number(xcNumber(ea.xcId)) - Number(xcNumber(eb.xcId));
        return collator.compare(recordingName(ea), recordingName(eb));
    });
    for (const n of nodes) if (n.kind === 'folder') sortNodes(n.children);
    return nodes;
}

export function buildRecordingTree(entries: any[]): TreeNode[] {
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
    return sortNodes(root);
}

/** IDs of all folders on the way to a recording (to unfold the active one). */
export function folderPathOf(tree: TreeNode[], recordingId: string): string[] {
    for (const n of tree) {
        if (n.kind === 'recording') { if (n.id === recordingId) return []; continue; }
        const sub = folderPathOf(n.children, recordingId);
        if (sub.length || n.children.some((c) => c.kind === 'recording' && c.id === recordingId)) return [n.id, ...sub];
    }
    return [];
}

export function countRecordings(node: TreeNode): number {
    return node.kind === 'recording' ? 1 : node.children.reduce((s, c) => s + countRecordings(c), 0);
}
