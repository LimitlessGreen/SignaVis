declare module '*.scss';
declare module '*.css';
declare module '*.less';
declare module '*.sass';

// Allow importing images in modules when typed-checking JS files
declare module '*.svg';
declare module '*.png';
declare module '*.jpg';
declare module '*.jpeg';

// Worker and inline query shims used by Vite imports
declare module '*?worker&inline';
declare module '*?worker';
declare module '*.worker.js';
declare module '*.worker';
