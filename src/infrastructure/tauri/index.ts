// ═══════════════════════════════════════════════════════════════════════
// infrastructure/tauri/index.ts
// ═══════════════════════════════════════════════════════════════════════

export { TauriProjectRepository, isTauriContext } from './TauriProjectRepository.ts';
export { TauriConnectionBridge } from './TauriConnectionBridge.ts';
export type { ConnectionConfig, ConnectionStatus, BackendMode, ConnectionState } from './TauriConnectionBridge.ts';
