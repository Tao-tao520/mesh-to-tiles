import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readObj } from './mesh/read-obj.js';
import { readGlb } from './mesh/read-glb.js';
import { boundsOf, binTriangles } from './partition.js';
import { buildTile } from './tile-glb.js';
import { createKtxPool } from './ktx2.js';
import { encodeSubtree, tilesetDocument } from './tileset.js';

export interface PipelineOptions {
  input: string;
  output: string;
  up?: 'z' | 'y';
  leafSize: number;
  leafError: number;
  maxLevels: number;
  longitude?: number;
  latitude?: number;
  height: number;
  ktx2: boolean;
  ktxLevel: number;
}

export async function run(options: PipelineOptions): Promise<void> {
  const started = Date.now();
  const inputPath = path.resolve(options.input);
  const outputDir = path.resolve(options.output);
  const ext = path.extname(inputPath).toLowerCase();
  const outputUp = options.up ?? 'y';
  if (outputUp !== 'z' && outputUp !== 'y') throw new Error('--up must be z or y');
  const hasGeoref = options.longitude !== undefined || options.latitude !== undefined;
  if (hasGeoref && (options.longitude === undefined || options.latitude === undefined)) {
    throw new Error('Pass both --longitude and --latitude, or neither. Height is not inferred.');
  }

  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu])
    .registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
    });

  console.log(`Reading ${inputPath} (output up=${outputUp})`);
  const mesh = ext === '.obj' ? await readObj(inputPath, 'z') : await readGlb(inputPath, io, 'y');
  if (!mesh.groups.length) throw new Error('No textured triangles were read.');

  const bounds = boundsOf(mesh);
  const sizeX = bounds.maxX - bounds.minX;
  const sizeY = bounds.maxY - bounds.minY;
  const sizeZ = bounds.maxZ - bounds.minZ;
  let levels = 1;
  while (levels < options.maxLevels && Math.max(sizeX, sizeY, sizeZ) / 2 ** (levels - 1) > options.leafSize) levels += 1;
  const maxLevel = levels - 1;
  const rootError = options.leafError * 2 ** maxLevel;
  console.log(
    `Bounds x[${bounds.minX.toFixed(1)}, ${bounds.maxX.toFixed(1)}] y[${bounds.minY.toFixed(1)}, ${bounds.maxY.toFixed(1)}] z[${bounds.minZ.toFixed(1)}, ${bounds.maxZ.toFixed(1)}]`,
  );
  console.log(`Octree levels=${levels} finestCell=${(Math.max(sizeX, sizeY, sizeZ) / 2 ** maxLevel).toFixed(1)}m rootError=${rootError}`);

  const imageCache = new Map();
  const tiles = binTriangles(mesh, bounds, maxLevel);
  console.log(`Occupied tiles: ${tiles.size}`);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const available = new Set<string>();
  let written = 0;
  const parallel = Math.max(1, Math.min(16, os.availableParallelism()));
  const ktxPool = options.ktx2 ? createKtxPool(parallel, options.ktxLevel) : null;
  const tileJobs = [...tiles.entries()];
  console.log(`Writing ${tileJobs.length} tiles, ${parallel} at a time`);
  for (let start = 0; start < tileJobs.length; start += parallel) {
    const batch = tileJobs.slice(start, start + parallel);
    await Promise.all(batch.map(async ([key, groups]) => {
      const [level, x, y, z] = key.split('/').map(Number);
      const texSize = Math.max(128, 4096 / 2 ** (maxLevel - level));
      const glb = await buildTile(io, mesh, groups, texSize, ktxPool, imageCache, ext === '.obj' ? 'bottom' : 'top', outputUp);
      const dest = path.join(outputDir, 'tiles', String(level), String(x), String(y), `${z}.glb`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, glb);
      available.add(key);
      written += 1;
      console.log(`  ${written}/${tiles.size}  ${key}  ${(glb.byteLength / 1024).toFixed(0)} KB  ${formatElapsed(started)}`);
    }));
  }
  if (ktxPool) await ktxPool.close();

  const subtree = encodeSubtree(maxLevel, available);
  fs.mkdirSync(path.join(outputDir, 'subtrees', '0', '0', '0'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'subtrees', '0', '0', '0', '0.subtree'), subtree);
  const tileset = tilesetDocument(
    bounds,
    rootError,
    levels,
    hasGeoref
      ? { longitude: options.longitude as number, latitude: options.latitude as number, height: options.height }
      : undefined,
  );
  if (hasGeoref) console.log(`Placed local origin at lon=${options.longitude} lat=${options.latitude} height=${options.height}`);
  else console.log('No --longitude/--latitude given. Tileset stays in local Z-up meters.');
  fs.writeFileSync(path.join(outputDir, 'tileset.json'), JSON.stringify(tileset, null, 2));
  console.log(`Done. ${written} tiles, ${(dirSize(outputDir) / 1024 / 1024).toFixed(1)} MB, ${formatElapsed(started)} -> ${outputDir}`);
}

function formatElapsed(started: number): string {
  const total = Math.round((Date.now() - started) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}
