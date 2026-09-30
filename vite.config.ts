import {defineConfig} from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';

/**
 * Library build (Vite 8 / rolldown):
 * - single CommonJS bundle at dist/index.js — matching the driver's original
 *   webpack commonjs2 output and tedb's own CJS consumption
 * - runtime dependencies (graceful-fs, tedb-utils) and node builtins stay
 *   external
 * - type declarations emitted alongside via vite-plugin-dts
 */
export default defineConfig({
    build: {
        lib: {
            entry: path.resolve(__dirname, 'src/index.ts'),
            formats: ['cjs'],
            fileName: () => 'index.js',
        },
        outDir: 'dist',
        emptyOutDir: true,
        minify: false,
        sourcemap: true,
        target: 'node20',
        rollupOptions: {
            external: [
                'graceful-fs',
                'tedb-utils',
                'fs',
                'path',
                'os',
                'node:fs',
                'node:path',
                'node:os',
            ],
        },
    },
    plugins: [
        dts({
            tsconfigPath: './tsconfig.build.json',
        }),
    ],
});
