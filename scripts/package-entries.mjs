// The package entries, in one place: the ESM build (vite.config.js), the type
// generation (scripts/generate-types.js) and package.json "exports" (checked by
// tests/package-entries.test.mjs) all follow this list.
//   name → { src, subpath } ; dist file: `${name}.esm.js`, types: `types/${typesName}.d.ts`
export const PACKAGE_ENTRIES = {
    'birdnet-player': { src: 'src/index.ts', subpath: '.', types: 'index' },
    core: { src: 'src/core.ts', subpath: './core', types: 'core', scss: 'src/styles/player.scss', cssSubpath: './core.css' },
    'label-table': { src: 'src/label-table.ts', subpath: './label-table', types: 'label-table', scss: 'src/styles/label-table.scss', cssSubpath: './label-table.css' },
};
// birdnet-player.css ('signavis/style') is core + every feature: Vite extracts it from src/index.ts.
