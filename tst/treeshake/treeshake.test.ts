import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';

// bundles small entries against the built dist with esbuild, which (unlike rollup) does not look
// inside callees: module-level code only drops if it is pure-annotated and the package declares
// `"sideEffects": false`. requires `pnpm build` first.

const root = fileURLToPath(new URL('../../', import.meta.url));

const bundle = async (contents: string) => {
    const result = await build({
        stdin: { contents, resolveDir: root, loader: 'js' },
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'browser',
        write: false,
        logLevel: 'silent',
        external: ['three'],
        alias: {
            navcat: `${root}dist/index.js`,
            'navcat/blocks': `${root}dist/blocks.js`,
            'navcat/three': `${root}dist/three.js`,
        },
    });

    return result.outputFiles[0].text;
};

describe('tree shaking', () => {
    beforeAll(() => {
        if (!existsSync(`${root}dist/index.js`)) {
            throw new Error('dist not found, run `pnpm build` before the tree shaking tests');
        }
    });

    test.each(['navcat', 'navcat/blocks', 'navcat/three'])(
        'a side-effect-only import of %s bundles to nothing',
        async (entry) => {
            expect(await bundle(`import '${entry}';`)).toBe('');
        },
    );

    test('importing one constant does not pull in module-level scratch', async () => {
        const output = await bundle(`import { INVALID_NODE_REF } from 'navcat'; console.log(INVALID_NODE_REF);`);

        expect(output.length).toBeLessThan(200);
    });

    test('importing one enum does not pull in the others', async () => {
        const output = await bundle(`import { NodeType } from 'navcat'; console.log(NodeType.POLY);`);

        expect(output).toContain('OFFMESH');
        expect(output).not.toContain('FIND_STRAIGHT_PATH_FAILED');
        expect(output.length).toBeLessThan(200);
    });

    test('importing one function keeps only what it uses', async () => {
        const output = await bundle(`import { getNodeRefType } from 'navcat'; console.log(getNodeRefType);`);

        expect(output.length).toBeLessThan(200);
    });
});
