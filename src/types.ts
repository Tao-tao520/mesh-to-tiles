export interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface MaterialGroup {
  name: string;
  image: string;
  /** Interleaved position index, texcoord index, three corners per triangle. */
  corners: number[];
  positions?: number[][];
  uvs?: number[];
}

export interface MeshData {
  positions: number[][] | null;
  uvs: number[] | null;
  groups: MaterialGroup[];
}

export interface BakedMesh {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  jpeg: Buffer;
}

export type TileGroups = Map<number, number[]>;
