// Minimal type stub for @tauri-apps/api/core.
// The real package is declared in devDependencies and installed
// together with the Rust toolchain setup (see DEVELOPER.md).
declare module '@tauri-apps/api/core' {
    /** Raw bodies (Uint8Array/ArrayBuffer) go with `options.headers`, as in @tauri-apps/api 2.x. */
    export function invoke<T = void>(
        cmd: string,
        args?: Record<string, unknown> | Uint8Array | ArrayBuffer | number[],
        options?: { headers: Record<string, string> | Headers },
    ): Promise<T>;
}
