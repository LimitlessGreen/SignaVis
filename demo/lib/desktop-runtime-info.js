function isTauriContext() {
  return typeof globalThis.__TAURI_INTERNALS__ !== 'undefined';
}

/**
 * Read desktop runtime metadata from Tauri IPC.
 * Returns null in browser mode or when IPC is unavailable.
 */
export async function getDesktopRuntimeInfo() {
  if (!isTauriContext()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('get_desktop_runtime_info');
  } catch {
    return null;
  }
}
