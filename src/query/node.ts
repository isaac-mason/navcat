import type { OffMeshConnectionSide } from './nav-mesh';

export enum NodeType {
    /** the node is a standard ground convex polygon that is part of the surface of the mesh */
    POLY = 0,
    /** the node is an off-mesh connection */
    OFFMESH = 1,
}

/** Serialized node reference */
export type NodeRef = GroundPolyNodeRef | OffMeshConnectionNodeRef;

/**
 * Poly node reference
 **/
export type GroundPolyNodeRef = number;

/**
 * Offmesh connection node reference
 */
export type OffMeshConnectionNodeRef = number;

/** Deserialised node reference */
export type DesNodeRef = DesPolyNodeRef | DesOffMeshNodeRef;
export type DesPolyNodeRef = [tileId: number, polyIndex: number, salt: number];
export type DesOffMeshNodeRef = [offMeshConnectionIndex: number, side: OffMeshConnectionSide, salt: number];

export const createPolyNodeRef = (): DesPolyNodeRef => [0, 0, 0];
export const createOffMeshNodeRef = (): DesOffMeshNodeRef => [0, 0, 0];

// Layout constants
const TYPE_BITS = 1;
const SALT_BITS = 7;
const POLY_BITS = 22;
const TILE_BITS = 22;

const POLY_SHIFT = TYPE_BITS + SALT_BITS; // 8
const TILE_SHIFT = POLY_SHIFT + POLY_BITS; // 30

// how tile spans low/high
const TILE_LOW_BITS = Math.min(32 - TILE_SHIFT, TILE_BITS); // 2
const TILE_HIGH_BITS = TILE_BITS - TILE_LOW_BITS; // 20

// masks (safe because all <= 31)
const TYPE_MASK = (1 << TYPE_BITS) - 1; // 0x1
const SALT_MASK = (1 << SALT_BITS) - 1; // 0x7f
const POLY_MASK = (1 << POLY_BITS) - 1; // 0x3fffff
const TILE_LOW_MASK = (1 << TILE_LOW_BITS) - 1;
const TILE_HIGH_MASK = (1 << TILE_HIGH_BITS) - 1;

const POW2_TILE_SHIFT = 2 ** TILE_SHIFT; // 2**30
const POW2_POLY_SHIFT = 2 ** POLY_SHIFT; // 2**8
const POW32 = 0x100000000; // 2**32

// maximum values for each field based on bit allocation
export const MAX_SALT = SALT_MASK; // 127 (7 bits)
export const MAX_POLY_INDEX = POLY_MASK; // 4194303 (22 bits: 2^22 - 1)
export const MAX_TILE_ID = (1 << TILE_BITS) - 1; // 4194303 (22 bits: 2^22 - 1)
export const MAX_OFFMESH_CONNECTION_INDEX = (1 << TILE_BITS) - 1; // 4194303 (reuses 22 bits)

export const serPolyNodeRef = (tileId: number, tileSalt: number, polyIndex: number): NodeRef => {
    // NOTE: mask inputs to avoid accidental overflow
    const t = tileId & ((1 << TILE_BITS) - 1);
    const p = polyIndex & POLY_MASK;
    const s = tileSalt & SALT_MASK;
    // pack as single JS number
    return t * POW2_TILE_SHIFT + p * POW2_POLY_SHIFT + (s << TYPE_BITS) + NodeType.POLY;
};

export const serOffMeshNodeRef = (offMeshConnectionId: number, salt: number, side: OffMeshConnectionSide): NodeRef => {
    const c = offMeshConnectionId & ((1 << TILE_BITS) - 1); // reuse TILE_BITS for connId
    const s = salt & SALT_MASK;
    const sd = side & 0x1;
    return c * POW2_TILE_SHIFT + sd * POW2_POLY_SHIFT + (s << TYPE_BITS) + NodeType.OFFMESH;
};

export const getNodeRefType = (ref: NodeRef): NodeType => {
    return (ref & TYPE_MASK) as NodeType;
};

export const desPolyNodeRef = (out: DesPolyNodeRef, ref: NodeRef): DesPolyNodeRef => {
    // split once
    const lo = ref >>> 0; // lower 32 bits (unsigned)
    const hi = Math.floor(ref / POW32); // upper bits (only up to ~20 bits here)

    // type is in lo bit0 (we don't need it here)
    out[2] = (lo >>> TYPE_BITS) & SALT_MASK; // salt (bits 1..7)
    out[1] = (lo >>> POLY_SHIFT) & POLY_MASK; // polyIndex (bits 8..29)

    // tileId spans low (bits 30..31) and high (bits 0..19 of hi)
    const tileLow = (lo >>> TILE_SHIFT) & TILE_LOW_MASK;
    const tileHigh = hi & TILE_HIGH_MASK;
    out[0] = (tileHigh << TILE_LOW_BITS) | tileLow;

    return out;
};

export const desOffMeshNodeRef = (out: DesOffMeshNodeRef, ref: NodeRef): DesOffMeshNodeRef => {
    const lo = ref >>> 0;
    const hi = Math.floor(ref / POW32);

    out[2] = (lo >>> TYPE_BITS) & SALT_MASK; // salt (bits 1..7)
    out[1] = (lo >>> POLY_SHIFT) & 0x1; // side stored in the poly slot low bit (bit 8)
    const connLow = (lo >>> TILE_SHIFT) & TILE_LOW_MASK;
    const connHigh = hi & TILE_HIGH_MASK;
    out[0] = (connHigh << TILE_LOW_BITS) | connLow;

    return out;
};
