import path from 'node:path';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import filesize from 'rollup-plugin-filesize';

export default [
  {
    input: `./src/index.ts`,
    output: [
      {
        dir: `dist`,
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
