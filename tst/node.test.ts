import { describe, test, expect } from "vitest";
import {
    NodeType,
    serPolyNodeRef,
    desPolyNodeRef,
    serOffMeshNodeRef,
    desOffMeshNodeRef,
    getNodeRefType,
    createPolyNodeRef,
    createOffMeshNodeRef,
} from "../src/query/node";

describe("node ref", () => {
    test("serdes poly node ref", () => {
        // Test with basic values
        const tileId = 100;
        const polyIndex = 200;
        const salt = 42;

        const nodeRef = serPolyNodeRef(tileId, salt, polyIndex);
        const out = createPolyNodeRef();
        desPolyNodeRef(out, nodeRef);

        // DesPolyNodeRef = [tileId, polyIndex, salt]
        expect(out[0]).toBe(tileId);
        expect(out[1]).toBe(polyIndex);
        expect(out[2]).toBe(salt);

        // Verify type detection
        expect(getNodeRefType(nodeRef)).toBe(NodeType.POLY);
    });

    test("serdes poly node ref with max values", () => {
        // Test with maximum 22-bit values
        const tileId = 0x3FFFFF; // Max 22 bits
        const polyIndex = 0x3FFFFF; // Max 22 bits
        const salt = 0x7F; // Max 7 bits (changed from 8 to 7)

        const nodeRef = serPolyNodeRef(tileId, salt, polyIndex);
        const out = createPolyNodeRef();
        desPolyNodeRef(out, nodeRef);

        // DesPolyNodeRef = [tileId, polyIndex, salt]
        expect(out[0]).toBe(tileId);
        expect(out[1]).toBe(polyIndex);
        expect(out[2]).toBe(salt);
    });

    test("serdes offmesh connection node ref", () => {
        // Test with basic values
        const offMeshConnectionId = 1000;
        const side = 1;
        const salt = 42;

        const nodeRef = serOffMeshNodeRef(offMeshConnectionId, salt, side);
        const out = createOffMeshNodeRef();
        desOffMeshNodeRef(out, nodeRef);

        // DesOffMeshNodeRef = [offMeshConnectionIndex, side, salt]
        expect(out[0]).toBe(offMeshConnectionId);
        expect(out[1]).toBe(side);
        expect(out[2]).toBe(salt);

        // Verify type detection
        expect(getNodeRefType(nodeRef)).toBe(NodeType.OFFMESH);
    });

    test("serdes offmesh connection node ref with max values", () => {
        // Test with maximum values - offmesh uses same 22 bits as tileId
        const offMeshConnectionId = 0x3FFFFF; // Max 22 bits (same as TILE_BITS)
        const side = 1; // Max 1 bit
        const salt = 0x7F; // Max 7 bits (changed from 8 to 7)

        const nodeRef = serOffMeshNodeRef(offMeshConnectionId, salt, side);
        const out = createOffMeshNodeRef();
        desOffMeshNodeRef(out, nodeRef);

        // DesOffMeshNodeRef = [offMeshConnectionIndex, side, salt]
        expect(out[0]).toBe(offMeshConnectionId);
        expect(out[1]).toBe(side);
        expect(out[2]).toBe(salt);
    });

    test("serdes offmesh connection node ref with both sides", () => {
        const offMeshConnectionId = 5000;
        const salt = 10;

        // Test side 0
        const nodeRef0 = serOffMeshNodeRef(offMeshConnectionId, salt, 0);
        const out0 = createOffMeshNodeRef();
        desOffMeshNodeRef(out0, nodeRef0);

        // DesOffMeshNodeRef = [offMeshConnectionIndex, side, salt]
        expect(out0[0]).toBe(offMeshConnectionId);
        expect(out0[1]).toBe(0);
        expect(out0[2]).toBe(salt);

        // Test side 1
        const nodeRef1 = serOffMeshNodeRef(offMeshConnectionId, salt, 1);
        const out1 = createOffMeshNodeRef();
        desOffMeshNodeRef(out1, nodeRef1);

        // DesOffMeshNodeRef = [offMeshConnectionIndex, side, salt]
        expect(out1[0]).toBe(offMeshConnectionId);
        expect(out1[1]).toBe(1);
        expect(out1[2]).toBe(salt);
    });
})