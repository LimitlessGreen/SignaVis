import { StorageProjectRepository } from '../project/index.ts';
import { LocalStorageAdapter } from '../storage/LocalStorageAdapter.ts';
import { isFullDesktop } from './runtime.ts';

/**
 * Create a project repository suitable for the current runtime.
 * - Full Tauri desktop: native filesystem-backed repository via Rust IPC
 * - Browser and SignaVis Lite: localStorage-backed repository
 */
export async function createProjectRepositoryRuntime() {
  if (isFullDesktop()) {
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
