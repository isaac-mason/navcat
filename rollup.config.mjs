import path from 'node:path';
import fs from 'node:fs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import filesize from 'rollup-plugin-filesize';

// Rewrite relative specifiers in emitted .d.ts files to include explicit `.js` extensions,
// so consumers using TypeScript's NodeNext module resolution can resolve them.
const addJsExtensionsToDts = () => ({
    name: 'add-js-extensions-to-dts',
    writeBundle() {
        const root = path.resolve('dist');
        if (!fs.existsSync(root)) return;
        const walk = (dir) =>
            fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
                const p = path.join(dir, d.name);
                return d.isDirectory() ? walk(p) : [p];
            });
        for (const file of walk(root).filter((f) => f.endsWith('.d.ts'))) {
            const dir = path.dirname(file);
            const original = fs.readFileSync(file, 'utf8');
            const fixed = original.replace(/(from\s+['"])(\.\.?(?:\/[^'"]*)?)(['"])/g, (_, pre, spec, post) => {
                const s = spec.replace(/\/$/, '');
                if (fs.existsSync(path.join(dir, `${s}.d.ts`))) return `${pre}${s}.js${post}`;
                if (fs.existsSync(path.join(dir, s, 'index.d.ts'))) return `${pre}${s}/index.js${post}`;
                return `${pre}${spec}${post}`;
            });
            if (fixed !== original) fs.writeFileSync(file, fixed);
        }
    },
});

export default [
    {
        input: './src/index.ts',
        external: ['mathcat'],
        output: [
            {
                file: 'dist/index.js',
                format: 'es',
                sourcemap: true,
                exports: 'named',
            },
        ],
        plugins: [
            nodeResolve(),
            typescript({
                tsconfig: path.resolve(import.meta.dirname, './tsconfig.json'),
                emitDeclarationOnly: true,
            }),
            addJsExtensionsToDts(),
            filesize(),
        ],
    },
    {
        input: './blocks/index.ts',
        external: ['mathcat', 'navcat'],
        output: [
            {
                file: 'dist/blocks.js',
                format: 'es',
                sourcemap: true,
                exports: 'named',
            },
        ],
        plugins: [
            nodeResolve(),
            typescript({
                tsconfig: path.resolve(import.meta.dirname, './tsconfig.json'),
                emitDeclarationOnly: true,
            }),
            addJsExtensionsToDts(),
            filesize(),
        ],
    },
    {
        input: './three/index.ts',
        external: ['mathcat', 'navcat', 'navcat/blocks', 'three'],
        output: [
            {
                file: 'dist/three.js',
                format: 'es',
                sourcemap: true,
                exports: 'named',
            },
        ],
        plugins: [
            nodeResolve(),
            typescript({
                tsconfig: path.resolve(import.meta.dirname, './tsconfig.json'),
                emitDeclarationOnly: true,
            }),
            addJsExtensionsToDts(),
            filesize(),
        ],
    },
];
