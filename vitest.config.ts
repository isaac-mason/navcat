import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // blocks import the library by its package name: test them against src, not a stale dist
        alias: [
            { find: /^navcat$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
            { find: /^navcat\/blocks$/, replacement: fileURLToPath(new URL('./blocks/index.ts', import.meta.url)) },
        ],
    },
});
