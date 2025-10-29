import { describe, expect, test } from 'vitest';
import {
    getNodeRefIndex,
    getNodeRefSequence,
    getNodeRefType,
    INVALID_NODE_REF,
    MAX_NODE_INDEX,
    MAX_SEQUENCE,
    NodeType,
    serNodeRef,
} from '../src';

describe('node ref', () => {
    test('serdes node ref with basic values', () => {
        const type = NodeType.POLY;
        const nodeIndex = 100;
        const sequence = 42;

        const nodeRef = serNodeRef(type, nodeIndex, sequence);

        expect(getNodeRefType(nodeRef)).toBe(type);
        expect(getNodeRefIndex(nodeRef)).toBe(nodeIndex);
        expect(getNodeRefSequence(nodeRef)).toBe(sequence);
    });

    test('serdes node ref with max values', () => {
        const type = NodeType.OFFMESH;
        const nodeIndex = MAX_NODE_INDEX; // Max 31 bits
        const sequence = MAX_SEQUENCE; // Max 20 bits

        const nodeRef = serNodeRef(type, nodeIndex, sequence);

        expect(getNodeRefType(nodeRef)).toBe(type);
        expect(getNodeRefIndex(nodeRef)).toBe(nodeIndex);
        expect(getNodeRefSequence(nodeRef)).toBe(sequence);
    });

    test('roundtrip various values with POLY type', () => {
        const testCases = [
            { nodeIndex: 0, sequence: 0 },
            { nodeIndex: 1, sequence: 1 },
            { nodeIndex: 12345, sequence: 50 },
            { nodeIndex: 1000000, sequence: 100000 },
            { nodeIndex: MAX_NODE_INDEX, sequence: MAX_SEQUENCE },
            { nodeIndex: MAX_NODE_INDEX >> 1, sequence: MAX_SEQUENCE >> 1 },
        ];

        for (const { nodeIndex, sequence } of testCases) {
            const nodeRef = serNodeRef(NodeType.POLY, nodeIndex, sequence);

            expect(getNodeRefType(nodeRef)).toBe(NodeType.POLY);
            expect(getNodeRefIndex(nodeRef)).toBe(nodeIndex);
            expect(getNodeRefSequence(nodeRef)).toBe(sequence);
        }
    });

    test('roundtrip various values with OFFMESH type', () => {
        const testCases = [
            { nodeIndex: 0, sequence: 0 },
            { nodeIndex: 1, sequence: 1 },
            { nodeIndex: 12345, sequence: 50 },
            { nodeIndex: 1000000, sequence: 100000 },
        ];

        for (const { nodeIndex, sequence } of testCases) {
            const nodeRef = serNodeRef(NodeType.OFFMESH, nodeIndex, sequence);

            expect(getNodeRefType(nodeRef)).toBe(NodeType.OFFMESH);
            expect(getNodeRefIndex(nodeRef)).toBe(nodeIndex);
            expect(getNodeRefSequence(nodeRef)).toBe(sequence);
        }
    });

    test('type bit is correctly isolated', () => {
        // Verify type bit doesn't interfere with other fields
        const nodeRef1 = serNodeRef(NodeType.POLY, 12345, 678);
        const nodeRef2 = serNodeRef(NodeType.OFFMESH, 12345, 678);

        expect(getNodeRefIndex(nodeRef1)).toBe(12345);
        expect(getNodeRefIndex(nodeRef2)).toBe(12345);
        expect(getNodeRefSequence(nodeRef1)).toBe(678);
        expect(getNodeRefSequence(nodeRef2)).toBe(678);
        expect(getNodeRefType(nodeRef1)).toBe(NodeType.POLY);
        expect(getNodeRefType(nodeRef2)).toBe(NodeType.OFFMESH);
    });

    test('32-bit boundary operations', () => {
        // Test values that cross the 32-bit boundary
        const type = NodeType.POLY;
        const nodeIndex = 0x7fffffff; // Max 31-bit value
        const sequence = 0xfffff; // Max 20-bit value

        const nodeRef = serNodeRef(type, nodeIndex, sequence);

        // All fields should be preserved correctly
        expect(getNodeRefType(nodeRef)).toBe(type);
        expect(getNodeRefIndex(nodeRef)).toBe(nodeIndex);
        expect(getNodeRefSequence(nodeRef)).toBe(sequence);
    });

    test('INVALID_NODE_REF equals -1', () => {
        expect(INVALID_NODE_REF).toBe(-1);
    });

    test('INVALID_NODE_REF is distinct from valid node refs', () => {
        // Ensure -1 doesn't collide with any valid serialized node ref
        const validNodeRefs = [
            serNodeRef(NodeType.POLY, 0, 0),
            serNodeRef(NodeType.POLY, 1, 1),
            serNodeRef(NodeType.POLY, MAX_NODE_INDEX, MAX_SEQUENCE),
            serNodeRef(NodeType.OFFMESH, 0, 0),
            serNodeRef(NodeType.OFFMESH, MAX_NODE_INDEX, MAX_SEQUENCE),
        ];

        for (const validNodeRef of validNodeRefs) {
            expect(validNodeRef).not.toBe(INVALID_NODE_REF);
        }
    });

    test('deserializing INVALID_NODE_REF does not throw', () => {
        expect(() => getNodeRefType(INVALID_NODE_REF)).not.toThrow();
        expect(() => getNodeRefIndex(INVALID_NODE_REF)).not.toThrow();
        expect(() => getNodeRefSequence(INVALID_NODE_REF)).not.toThrow();

        const type = getNodeRefType(INVALID_NODE_REF);
        const index = getNodeRefIndex(INVALID_NODE_REF);
        const sequence = getNodeRefSequence(INVALID_NODE_REF);

        expect(type).toBe(1);
        expect(index).toBe(2147483647);
        expect(sequence).toBe(1048575);
    });
});
