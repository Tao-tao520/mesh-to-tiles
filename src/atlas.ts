import sharp from 'sharp';
import type { MeshData, BakedMesh, TileGroups } from './types.js';
import { groupPositions, groupUvs } from './partition.js';

interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

interface Corner {
  p: number[];
  u: number;
  v: number;
  ti: number;
}

interface Island {
  image: RawImage;
  tris: Corner[][];
  left: number;
  top: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export async function loadRaw(cache: Map<string, RawImage>, imagePath: string, full: boolean): Promise<RawImage> {
  const key = full ? `full:${imagePath}` : imagePath;
  const cached = cache.get(key);
  if (cached) return cached;
  let pipeline = sharp(imagePath).ensureAlpha();
  if (!full) pipeline = pipeline.resize(2048, 2048, { fit: 'fill' });
  const decoded = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const image = { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
  cache.set(key, image);
  return image;
}

export async function repackIslands(
  mesh: MeshData,
  groups: TileGroups,
  size: number,
  cache: Map<string, RawImage>,
  full: boolean,
  vZero: 'top' | 'bottom',
): Promise<BakedMesh> {
  const islands: Omit<Island, 'dx' | 'dy' | 'dw' | 'dh'>[] = [];
  for (const [groupIndex, triIds] of groups) {
    const group = mesh.groups[groupIndex];
    const srcPos = groupPositions(mesh, group);
    const srcUv = groupUvs(mesh, group);
    const separate = !group.positions;
    const parent = new Map<number, number>();
    const find = (id: number): number => {
      if (!parent.has(id)) parent.set(id, id);
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root) as number;
      let cursor = id;
      while (cursor !== root) {
        const next = parent.get(cursor) as number;
        parent.set(cursor, root);
        cursor = next;
      }
      return root;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };
    const tris: Corner[][] = [];
    for (const tri of triIds) {
      const corners = [0, 1, 2].map((k) => {
        const vi = group.corners[tri * 6 + k * 2];
        const ti = separate ? group.corners[tri * 6 + k * 2 + 1] : vi;
        return { p: srcPos[vi], u: srcUv[ti * 2], v: srcUv[ti * 2 + 1], ti };
      });
      union(corners[0].ti, corners[1].ti);
      union(corners[1].ti, corners[2].ti);
      tris.push(corners);
    }
    const grouped = new Map<number, { u0: number; u1: number; v0: number; v1: number; tris: Corner[][] }>();
    for (const corners of tris) {
      const id = find(corners[0].ti);
      let box = grouped.get(id);
      if (!box) {
        box = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity, tris: [] };
        grouped.set(id, box);
      }
      box.tris.push(corners);
      for (const corner of corners) {
        box.u0 = Math.min(box.u0, corner.u);
        box.u1 = Math.max(box.u1, corner.u);
        box.v0 = Math.min(box.v0, corner.v);
        box.v1 = Math.max(box.v1, corner.v);
      }
    }
    const image = await loadRaw(cache, group.image, full);
    for (const box of grouped.values()) {
      const pad = 4;
      const vTop = vZero === 'top' ? box.v0 : 1 - box.v1;
      const vBottom = vZero === 'top' ? box.v1 : 1 - box.v0;
      let left = Math.max(0, Math.floor(box.u0 * image.width) - pad);
      let right = Math.min(image.width, Math.ceil(box.u1 * image.width) + pad);
      let top = Math.max(0, Math.floor(vTop * image.height) - pad);
      let bottom = Math.min(image.height, Math.ceil(vBottom * image.height) + pad);
      if (right <= left) right = Math.min(image.width, left + 1);
      if (bottom <= top) bottom = Math.min(image.height, top + 1);
      islands.push({ image, tris: box.tris, left, top, w: right - left, h: bottom - top });
    }
  }
  const maxDim = islands.reduce((m, island) => Math.max(m, island.w, island.h), 1);
  let scale = Math.min(1, (size - 2) / maxDim);
  let placed: Island[] | null = null;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    placed = packRects(islands, size, scale);
    if (placed) break;
    scale *= 0.8;
  }
  if (!placed) throw new Error('Could not pack UV islands.');
  const pixels = new Uint8Array(size * size * 3);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const island of placed) {
    blit(island, pixels, size);
    for (const corners of island.tris) {
      const base = positions.length / 3;
      for (const corner of corners) {
        positions.push(corner.p[0], corner.p[1], corner.p[2]);
        const nu = (island.dx + ((corner.u * island.image.width - island.left) / island.w) * island.dw) / size;
        const sourceV = vZero === 'top' ? corner.v : 1 - corner.v;
        const ay = island.dy + (((sourceV * island.image.height - island.top) / island.h) * island.dh);
        uvs.push(nu, ay / size);
      }
      indices.push(base, base + 1, base + 2);
    }
  }
  const jpeg = await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 82 }).toBuffer();
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), jpeg };
}

function packRects(islands: Omit<Island, 'dx' | 'dy' | 'dw' | 'dh'>[], size: number, scale: number): Island[] | null {
  const boxes = islands.map((island) => ({
    island,
    w: Math.max(1, Math.ceil(island.w * scale)),
    h: Math.max(1, Math.ceil(island.h * scale)),
  }));
  boxes.sort((a, b) => b.h - a.h || b.w - a.w);
  let x = 1;
  let y = 1;
  let rowH = 0;
  const placed: Island[] = [];
  for (const box of boxes) {
    if (box.w > size - 2 || box.h > size - 2) return null;
    if (x + box.w + 1 > size) {
      x = 1;
      y += rowH + 1;
      rowH = 0;
    }
    if (y + box.h + 1 > size) return null;
    placed.push({ ...box.island, dx: x, dy: y, dw: box.w, dh: box.h });
    x += box.w + 1;
    rowH = Math.max(rowH, box.h);
  }
  return placed;
}

function blit(island: Island, pixels: Uint8Array, size: number): void {
  const { image, left, top, w, h, dx, dy, dw, dh } = island;
  for (let y = 0; y < dh; y += 1) {
    const sy = top + Math.min(h - 1, Math.floor(((y + 0.5) * h) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx = left + Math.min(w - 1, Math.floor(((x + 0.5) * w) / dw));
      const si = (sy * image.width + sx) * 4;
      const di = ((dy + y) * size + (dx + x)) * 3;
      pixels[di] = image.data[si];
      pixels[di + 1] = image.data[si + 1];
      pixels[di + 2] = image.data[si + 2];
    }
  }
}
