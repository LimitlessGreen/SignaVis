/** Vite handles CSS imports at build time; declare them for TypeScript. */
declare module '*.css';

/** Vite web-worker imports with query suffixes. */
declare module '*?worker&inline' {
    const workerConstructor: new () => Worker;
    export default workerConstructor;
}
