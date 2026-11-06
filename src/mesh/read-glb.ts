import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import type { MeshData } from '../types.js';
import { toZUp } from './read-obj.js';

export async function readGlb(glbPath: string, nodeIo: NodeIO, up: 'z' | 'y'): Promise<MeshData> {
  const doc = await nodeIo.read(glbPath);
  const groups = [];
  let index = 0;
  for (const prim of doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
    const posAcc = prim.getAttribute('POSITION');
    const uvAcc = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    const texture = prim.getMaterial()?.getBaseColorTexture();
    const image = texture?.getImage();
    if (!posAcc || !uvAcc || !idx || !image) continue;
    const imagePath = path.join(os.tmpdir(), `mesh-to-tiles-${process.pid}-${index}.png`);
    fs.writeFileSync(imagePath, await sharp(Buffer.from(image)).png().toBuffer());
    const src = posAcc.getArray();
    if (!src) continue;
    const positions = [];
    for (let i = 0; i < src.length; i += 3) positions.push(toZUp(up, src[i], src[i + 1], src[i + 2]));
    const uv = uvAcc.getArray();
    const indices = idx.getArray();
    if (!uv || !indices) continue;
    const corners = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      corners.push(a, a, b, b, c, c);
    }
    const uvs: number[] = [];
    for (let i = 0; i < uv.length; i += 1) uvs.push(uv[i]);
    groups.push({ name: `prim${index}`, image: imagePath, corners, positions, uvs });
    index += 1;
  }
  if (groups.length && groups[0].positions) return { positions: null, uvs: null, groups };
  return { positions: [], uvs: [], groups };
}
