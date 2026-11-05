import { isFullDesktop } from './runtime.ts';

/**
 * Read desktop runtime metadata from Tauri IPC.
 * Returns null in browser mode, in SignaVis Lite, or when IPC is unavailable.
 */
export async function getDesktopRuntimeInfo() {
  if (!isFullDesktop()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('get_desktop_runtime_info');
  } catch {
    return null;
  }
}
