import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import type { BakedMesh, MeshData, TileGroups } from './types.js';
import { repackIslands } from './atlas.js';
import type { KtxPool } from './ktx2.js';
import { encodeKtx2 } from './ktx2.js';

export async function buildTile(
  nodeIo: NodeIO,
  mesh: MeshData,
  groups: TileGroups,
  texLimit: number,
  ktxPool: KtxPool | null,
  imageCache: Map<string, { data: Uint8Array; width: number; height: number }>,
  vZero: 'top' | 'bottom',
): Promise<Buffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const unlit = doc.createExtension(KHRMaterialsUnlit).createUnlit();
  const scene = doc.createScene();
  const node = doc.createNode();
  const outMesh = doc.createMesh();
  scene.addChild(node);
  node.setMesh(outMesh);
  addBakedPrimitive(doc, buffer, outMesh, unlit, await repackIslands(mesh, groups, texLimit, imageCache, texLimit >= 4096, vZero));
  if (ktxPool) await encodeKtx2(doc, ktxPool);
  await doc.transform(draco({ method: 'edgebreaker', quantizePosition: 16, quantizeTexcoord: 12 }));
  return Buffer.from(await nodeIo.writeBinary(doc));
}

function addBakedPrimitive(
  doc: Document,
  buffer: ReturnType<Document['createBuffer']>,
  outMesh: ReturnType<Document['createMesh']>,
  unlit: ReturnType<KHRMaterialsUnlit['createUnlit']>,
  baked: BakedMesh,
): void {
  const glPositions = new Float32Array(baked.positions.length);
  for (let i = 0; i < baked.positions.length; i += 3) {
    // glTF is Y-up. Cesium rotates +90° about X, so (x, z, -y) lands on Z-up (x, y, z).
    glPositions[i] = baked.positions[i];
    glPositions[i + 1] = baked.positions[i + 2];
    glPositions[i + 2] = -baked.positions[i + 1];
  }
  const prim = doc.createPrimitive();
  prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(glPositions).setBuffer(buffer));
  prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(baked.uvs).setBuffer(buffer));
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(baked.indices).setBuffer(buffer));
  const material = doc.createMaterial().setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(1);
  material.setExtension('KHR_materials_unlit', unlit);
  const texture = doc.createTexture('baseColor');
  texture.setImage(baked.jpeg);
  texture.setMimeType('image/jpeg');
  material.setBaseColorTexture(texture);
  const textureInfo = material.getBaseColorTextureInfo();
  if (!textureInfo) throw new Error('Base color texture was not attached.');
  textureInfo.setWrapS(33071);
  textureInfo.setWrapT(33071);
  textureInfo.setMinFilter(9729);
  textureInfo.setMagFilter(9729);
  prim.setMaterial(material);
  outMesh.addPrimitive(prim);
}
