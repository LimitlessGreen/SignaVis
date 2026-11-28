/** Vite handles CSS imports at build time; declare them for TypeScript. */
declare module '*.css';

/** Vite web-worker imports with query suffixes. */
declare module '*?worker&inline' {
    const workerConstructor: new () => Worker;
    export default workerConstructor;
}

/** Vite asset URL imports (used for the .wasm binary). */
declare module '*?url' {
    const url: string;
    export default url;
}

/** Vite raw text imports (inline SVG markup, e.g. the brand mark). */
declare module '*?raw' {
    const text: string;
    export default text;
}
