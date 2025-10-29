import { describe, expect, test } from 'vitest';
import { mergeStartMoved } from '../blocks/agents/path-corridor';
import type { NodeRef } from '../src';

describe('mergeStartMoved', () => {
    test('should handle empty input', () => {
        const path: NodeRef[] = [];
        const visited: NodeRef[] = [];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([]);
    });

    test('should handle empty visited', () => {
        const path: NodeRef[] = [1];
        const visited: NodeRef[] = [];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([1]);
    });

    test('should strip visited points from path except last', () => {
        const path: NodeRef[] = [1, 2];
        const visited: NodeRef[] = [1, 2];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([2]);
    });

    test('should add visited points not present in path in reverse order', () => {
        const path: NodeRef[] = [1, 2];
        const visited: NodeRef[] = [1, 2, 3, 4];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([4, 3, 2]);
    });

    test('should not change path if there is no intersection with visited', () => {
        const path: NodeRef[] = [1, 2];
        const visited: NodeRef[] = [3, 4];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([1, 2]);
    });

    test('should save unvisited path points', () => {
        const path: NodeRef[] = [1, 2];
        const visited: NodeRef[] = [1, 3];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([3, 1, 2]);
    });

    test('should handle complex merge scenario', () => {
        const path: NodeRef[] = [1, 2, 3, 4];
        const visited: NodeRef[] = [1, 5, 6, 2];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([2, 3, 4]);
    });

    test('should handle when visited ends at path start', () => {
        const path: NodeRef[] = [1, 2, 3];
        const visited: NodeRef[] = [4, 5, 1];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([1, 2, 3]);
    });

    test('should handle single element path and visited with same element', () => {
        const path: NodeRef[] = [1];
        const visited: NodeRef[] = [1];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([1]);
    });

    test('should handle visited path that completely replaces current path', () => {
        const path: NodeRef[] = [1, 2];
        const visited: NodeRef[] = [3, 4, 5, 2];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([2]);
    });

    test('should handle multiple common polygons and use furthest', () => {
        const path: NodeRef[] = [1, 2, 3, 2, 4];
        const visited: NodeRef[] = [1, 5, 2];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([2, 4]);
    });

    test('should handle long visited path', () => {
        const path: NodeRef[] = [1, 2, 3];
        const visited: NodeRef[] = [1, 10, 11, 12, 13, 14, 15, 3];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([3]);
    });

    test('should handle visited starting in middle of path', () => {
        const path: NodeRef[] = [1, 2, 3, 4, 5];
        const visited: NodeRef[] = [3, 6, 7, 8];
        const result = mergeStartMoved(path, visited);
        expect(result).toEqual([8, 7, 6, 3, 4, 5]);
    });
});
