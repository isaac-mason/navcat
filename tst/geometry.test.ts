import { vec3 } from 'maaths';
import { describe, expect, test } from 'vitest';
import { pointInPoly } from '../src/geometry';

describe('geometry.pointInPoly', () => {
    test('point on edge is considered inside', () => {
        // Square in XZ plane: (0,0),(1,0),(1,1),(0,1)
        const verts = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
        const nv = 4;
        // point exactly on the bottom edge between (0,0) and (1,0)
        const pt = vec3.fromValues(0.5, 0, 0);

        expect(pointInPoly(pt, verts, nv)).toBe(true);
    });

    test('point outside polygon is false', () => {
        const verts = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
        const nv = 4;
        const pt = vec3.fromValues(1.5, 0, 0.5);

        expect(pointInPoly(pt, verts, nv)).toBe(false);
    });

    test('point on vertical edge is inside', () => {
        // vertices from the user (flat x,y,z array)
        const verts = [-13, 0, -10, -15, 0, -10, -14, 0, -8.5, -13, 0, -8.5];
        const nv = 4;
        // point located on the vertical edge between first and last vertex
        const pt = vec3.fromValues(-13, 0, -9);

        expect(pointInPoly(pt, verts, nv)).toBe(true);
    });
});
