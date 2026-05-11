import { StorageProjectRepository } from '../project/index.ts';
import { LocalStorageAdapter } from '../storage/LocalStorageAdapter.ts';

/**
 * Create a project repository suitable for the current runtime.
 * - Tauri desktop: native filesystem-backed repository via Rust IPC
 * - Browser: localStorage-backed repository
 */
export async function createProjectRepositoryRuntime() {
  const isTauri = typeof (globalThis as any).__TAURI_INTERNALS__ !== 'undefined';
  if (isTauri) {
    const { TauriProjectRepository } = await import('./TauriProjectRepository.ts');
    return {
      backend: 'tauri',
      repo: new TauriProjectRepository(),
    };
  }

  return {
    backend: 'browser',
    repo: new StorageProjectRepository(new LocalStorageAdapter()),
  };
}
