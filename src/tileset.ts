import type { Bounds } from './types.js';
import { enuTransform } from './enu.js';

export function morton2D(x: number, y: number): number {
  let result = 0;
  for (let i = 0; i < 16; i += 1) {
    result |= (x & (1 << i)) << i;
    result |= (y & (1 << i)) << (i + 1);
  }
  return result;
}

export function morton3D(x: number, y: number, z: number): number {
  let result = 0;
  for (let i = 0; i < 10; i += 1) {
    result |= (x & (1 << i)) << (2 * i);
    result |= (y & (1 << i)) << (2 * i + 1);
    result |= (z & (1 << i)) << (2 * i + 2);
  }
  return result;
}

export function encodeSubtree(
  maxLevel: number,
  available: Set<string>,
  content: Set<string> = available,
  scheme: 'OCTREE' | 'QUADTREE' = 'OCTREE',
): Buffer {
  const levels = maxLevel + 1;
  const nodeCount = scheme === 'QUADTREE' ? (4 ** levels - 1) / 3 : (8 ** levels - 1) / 7;
  const tileBytes = Math.ceil(nodeCount / 8);
  const tileBits = Buffer.alloc(tileBytes);
  const contentBits = Buffer.alloc(tileBytes);
  let tileCount = 0;
  let contentCount = 0;
  const mark = (bits: Buffer, key: string) => {
    const parts = key.split('/').map(Number);
    const level = parts[0];
    const index = scheme === 'QUADTREE'
      ? (4 ** level - 1) / 3 + morton2D(parts[1], parts[2])
      : (8 ** level - 1) / 7 + morton3D(parts[1], parts[2], parts[3]);
    bits[index >> 3] |= 1 << (index & 7);
  };
  for (const key of available) {
    mark(tileBits, key);
    tileCount += 1;
  }
  for (const key of content) {
    mark(contentBits, key);
    contentCount += 1;
  }
  const bin = Buffer.concat([tileBits, contentBits]);
  const json = {
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: tileBytes },
      { buffer: 0, byteOffset: tileBytes, byteLength: tileBytes },
    ],
    tileAvailability: { bitstream: 0, availableCount: tileCount },
    contentAvailability: [{ bitstream: 1, availableCount: contentCount }],
    childSubtreeAvailability: { constant: 0 },
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  const pad = (8 - (jsonBuf.length % 8)) % 8;
  if (pad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(24);
  header.write('subt', 0, 'ascii');
  header.writeUInt32LE(1, 4);
  header.writeBigUInt64LE(BigInt(jsonBuf.length), 8);
  header.writeBigUInt64LE(BigInt(bin.length), 16);
  return Buffer.concat([header, jsonBuf, bin]);
}

export function tilesetDocument(
  bounds: Bounds,
  rootError: number,
  levels: number,
  georef?: { longitude: number; latitude: number; height: number },
  scheme: 'OCTREE' | 'QUADTREE' = 'OCTREE',
): Record<string, unknown> {
  const hx = (bounds.maxX - bounds.minX) / 2;
  const hy = (bounds.maxY - bounds.minY) / 2;
  const hz = (bounds.maxZ - bounds.minZ) / 2;
  const root: Record<string, unknown> = {
    boundingVolume: {
      box: [
        bounds.minX + hx, bounds.minY + hy, bounds.minZ + hz,
        hx, 0, 0,
        0, hy, 0,
        0, 0, hz,
      ],
    },
    geometricError: rootError,
    refine: 'REPLACE',
    content: { uri: scheme === 'QUADTREE' ? 'tiles/{level}/{x}/{y}.glb' : 'tiles/{level}/{x}/{y}/{z}.glb' },
    implicitTiling: {
      subdivisionScheme: scheme,
      availableLevels: levels,
      subtreeLevels: levels,
      subtrees: { uri: scheme === 'QUADTREE' ? 'subtrees/{level}/{x}/{y}.subtree' : 'subtrees/{level}/{x}/{y}/{z}.subtree' },
    },
  };
  if (georef) root.transform = enuTransform(georef.longitude, georef.latitude, georef.height);
  const extent = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  return { asset: { version: '1.1' }, geometricError: extent, root };
}
