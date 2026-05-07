import { StorageProjectRepository } from '../../src/infrastructure/project/index.ts';
import { LocalStorageAdapter } from '../../src/infrastructure/storage/LocalStorageAdapter.ts';

/**
 * Create a project repository suitable for the current runtime.
 * - Tauri desktop: native filesystem-backed repository via Rust IPC
 * - Browser: localStorage-backed repository
 */
export async function createProjectRepositoryRuntime() {
  const isTauri = typeof globalThis.__TAURI_INTERNALS__ !== 'undefined';
  if (isTauri) {
    const { TauriProjectRepository } = await import('../../src/infrastructure/tauri/TauriProjectRepository.ts');
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
