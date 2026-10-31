// ═══════════════════════════════════════════════════════════════════════
// infrastructure/project/OpfsProjectStore.ts — browser-private project
//
// IProjectStore on the Origin Private File System (all current browsers).
// Layout under the OPFS root:  projects/<name>/project.signavis.json, …
// ═══════════════════════════════════════════════════════════════════════

import { DirectoryProjectStore } from './DirectoryProjectStore.ts';

export class OpfsProjectStore extends DirectoryProjectStore {
    /** Null when OPFS (with createWritable) is unavailable — callers fall back to legacy storage. */
    static async open(name = 'default'): Promise<OpfsProjectStore | null> {
        try {
            const opfs = await (navigator as any).storage?.getDirectory?.();
            if (!opfs) return null;
            const projects = await opfs.getDirectoryHandle('projects', { create: true });
            const root = await projects.getDirectoryHandle(name, { create: true });
            const probe = await root.getFileHandle('.probe', { create: true });
            const writable = typeof probe.createWritable === 'function';
            await root.removeEntry('.probe').catch(() => {});
            if (!writable) return null;
            try { await (navigator as any).storage?.persist?.(); } catch { /* ignore */ }
            return new OpfsProjectStore(root, { label: 'Browser project', userVisible: false });
        } catch { return null; }
    }
}
