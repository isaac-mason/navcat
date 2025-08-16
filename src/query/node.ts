import type { OffMeshConnectionSide } from "./nav-mesh";

export enum NodeType {
    /** the node is a standard ground convex polygon that is part of the surface of the mesh */
    GROUND_POLY = 0,
    /** the node is an off-mesh connection */
    OFFMESH_CONNECTION = 1,
}

/** A serialized node reference */
export type NodeRef = GroundPolyNodeRef | OffMeshConnectionNodeRef;
export type GroundPolyNodeRef = `${NodeType.GROUND_POLY},${number},${number}`;
export type OffMeshConnectionNodeRef =
    `${NodeType.OFFMESH_CONNECTION},${number},${number}`;

/** A deserialised node reference */
export type DeserialisedNodeRef =
    | DeserialisedGroundNodeRef
    | DeserialisedOffMeshConnectionNodeRef;
export type DeserialisedGroundNodeRef = [
    nodeType: NodeType.GROUND_POLY,
    tileId: number,
    nodeIndex: number,
];
export type DeserialisedOffMeshConnectionNodeRef = [
    nodeType: NodeType.OFFMESH_CONNECTION,
    offMeshConnectionIndex: number,
    side: OffMeshConnectionSide,
];

export const serOffMeshNodeRef = (
    offMeshConnectionId: string,
    side: OffMeshConnectionSide,
): NodeRef => {
    return `${NodeType.OFFMESH_CONNECTION},${offMeshConnectionId},${side}` as OffMeshConnectionNodeRef;
};

export function serPolyNodeRef(tileId: number, polyIndex: number): NodeRef {
    return `${NodeType.GROUND_POLY},${tileId},${polyIndex}` as NodeRef;
}

export const getNodeRefType = (nodeRef: NodeRef): NodeType => {
    return Number(nodeRef[0]) as NodeType;
};

export const desNodeRef = (nodeRef: NodeRef): DeserialisedNodeRef => {
    return nodeRef.split(',').map(Number) as DeserialisedNodeRef;
};