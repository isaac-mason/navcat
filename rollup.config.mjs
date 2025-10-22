import path from 'node:path';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import filesize from 'rollup-plugin-filesize';

export default [
    {
        input: './src/index.ts',
        external: ['maaths'],
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
            filesize(),
        ],
    },
    {
        input: './blocks/index.ts',
        external: ['maaths', 'navcat'],
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
            filesize(),
        ],
    },
    {
        input: './three/index.ts',
        external: ['maaths', 'navcat', 'three'],
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
            filesize(),
        ],
    },
];
