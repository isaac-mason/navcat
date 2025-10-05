export enum NodeType {
    /** the node is a standard ground convex polygon that is part of the surface of the mesh */
    POLY = 0,
    /** the node is an off-mesh connection */
    OFFMESH = 1,
}

/** 
 * Serialized node reference
 * Layout (52 bits total):
 * - Bit 1: type (1 bit) - fast access with 32-bit bitwise ops
 * - Bits 2-32: nodeIndex (31 bits) - fast access with 32-bit bitwise ops  
 * - Bits 33-52: sequenceNumber (20 bits) - requires non-32-bit bitwise ops
 */
export type NodeRef = number;

const TYPE_BITS = 1;
const NODE_INDEX_BITS = 31;
const SEQUENCE_BITS = 20;

// masks for 32-bit operations (bits 1-32)
const TYPE_MASK = 0x1; // bit 1
const NODE_INDEX_MASK = 0x7FFFFFFF; // bits 2-32 (31 bits)
const NODE_INDEX_SHIFT = TYPE_BITS; // 1

// sequence number uses bits beyond 32-bit boundary (bits 33-52)
const SEQUENCE_SHIFT = TYPE_BITS + NODE_INDEX_BITS; // 32
const SEQUENCE_MASK = (1 << SEQUENCE_BITS) - 1; // 0xFFFFF (20 bits)

// maximum values for each field based on bit allocation
export const MAX_NODE_INDEX = NODE_INDEX_MASK; // 2147483647 (31 bits: 2^31 - 1)
export const MAX_SEQUENCE = SEQUENCE_MASK; // 1048575 (20 bits: 2^20 - 1)


/** Serializes a node reference from its components */
export const serNodeRef = (type: NodeType, nodeIndex: number, sequence: number): NodeRef => {
    // NOTE: mask inputs to avoid accidental overflow
    const t = type & TYPE_MASK;
    const n = nodeIndex & NODE_INDEX_MASK;
    const s = sequence & SEQUENCE_MASK;
    
    // Pack as: [type: 1 bit][nodeIndex: 31 bits][sequence: 20 bits]
    // Use multiplication instead of bitwise shift to avoid 32-bit truncation, we encode sequence in higher bits
    return t + (n * 2) + (s * 2 ** SEQUENCE_SHIFT);
};

/** Gets the node type from a node reference */
export const getNodeRefType = (ref: NodeRef): NodeType => {
    // fast truncated 32-bit operation
    return (ref & TYPE_MASK) as NodeType;
};

/** Gets the node index from a node reference */
export const getNodeRefIndex = (ref: NodeRef): number => {
    // fast truncated 32-bit operation
    return (ref >>> NODE_INDEX_SHIFT) & NODE_INDEX_MASK;
};

/** Gets the sequence number from a node reference */
export const getNodeRefSequence = (ref: NodeRef): number => {
    // non-32-bit operation, use division for bits beyond 32-bit boundary
    return Math.floor(ref / 2 ** SEQUENCE_SHIFT) & SEQUENCE_MASK;
};
