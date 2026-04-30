import fs from 'node:fs';
import path from 'node:path';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import filesize from 'rollup-plugin-filesize';

const fixDtsExtensions = () => ({
    name: 'fix-dts-extensions',
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
            const fixed = original.replace(
                /(from\s+['"])(\.[^'"]+)(['"])/g,
                (_, pre, spec, post) => {
                    if (fs.existsSync(path.join(dir, `${spec}.d.ts`))) return `${pre}${spec}.js${post}`;
                    if (fs.existsSync(path.join(dir, spec, 'index.d.ts'))) return `${pre}${spec}/index.js${post}`;
                    return `${pre}${spec}${post}`;
                },
            );
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
            fixDtsExtensions(),
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
            fixDtsExtensions(),
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
            fixDtsExtensions(),
            filesize(),
        ],
    },
];
