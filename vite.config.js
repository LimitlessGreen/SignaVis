import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, 'src/app/BirdNETPlayer.js'),
            name: 'BirdNETPlayerModule',
            formats: ['es', 'iife'],
            fileName: (format) => {
                if (format === 'es')   return 'birdnet-player.esm.js';
                if (format === 'iife') return 'birdnet-player.iife.js';
                return `birdnet-player.${format}.js`;
            },
            cssFileName: 'birdnet-player',
        },
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            // WaveSurfer is loaded at runtime (CDN / global / option),
            // NOT bundled — mark as external if it ever shows up as import
            external: ['wavesurfer.js'],
            output: {
                globals: {
                    'wavesurfer.js': 'WaveSurfer',
                },
                // Ensure IIFE wraps exports on the right global
                exports: 'named',
            },
        },
        target: 'es2020',
        minify: false,       // Keep readable for now; flip for release
        sourcemap: true,
    },
});
