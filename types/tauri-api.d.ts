// Minimal type stub for @tauri-apps/api/core.
// The real package is declared in devDependencies and installed
// together with the Rust toolchain setup (see DEVELOPER.md).
declare module '@tauri-apps/api/core' {
    export function invoke<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}
