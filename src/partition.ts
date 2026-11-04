import type { Bounds, MeshData, TileGroups } from './types.js';

export function groupPositions(mesh: MeshData, group: MeshData['groups'][number]): number[][] {
  return group.positions || mesh.positions || [];
}

export function groupUvs(mesh: MeshData, group: MeshData['groups'][number]): number[] {
  return group.uvs || mesh.uvs || [];
}

export function boundsOf(mesh: MeshData): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const visit = (positions: number[][]) => {
    for (const p of positions) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      minZ = Math.min(minZ, p[2]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
      maxZ = Math.max(maxZ, p[2]);
    }
  };
  if (mesh.positions) visit(mesh.positions);
  else for (const group of mesh.groups) if (group.positions) visit(group.positions);
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export function binTriangles(mesh: MeshData, bounds: Bounds, deepest: number): Map<string, TileGroups> {
  const tiles = new Map<string, TileGroups>();
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  const spanZ = bounds.maxZ - bounds.minZ || 1;
  for (let g = 0; g < mesh.groups.length; g += 1) {
    const group = mesh.groups[g];
    const positions = groupPositions(mesh, group);
    const triCount = group.corners.length / 6;
    for (let t = 0; t < triCount; t += 1) {
      const a = positions[group.corners[t * 6]];
      const b = positions[group.corners[t * 6 + 2]];
      const c = positions[group.corners[t * 6 + 4]];
      const cx = (a[0] + b[0] + c[0]) / 3;
      const cy = (a[1] + b[1] + c[1]) / 3;
      const cz = (a[2] + b[2] + c[2]) / 3;
      for (let level = 0; level <= deepest; level += 1) {
        const div = 2 ** level;
        const x = Math.min(div - 1, Math.max(0, Math.floor(((cx - bounds.minX) / spanX) * div)));
        const y = Math.min(div - 1, Math.max(0, Math.floor(((cy - bounds.minY) / spanY) * div)));
        const z = Math.min(div - 1, Math.max(0, Math.floor(((cz - bounds.minZ) / spanZ) * div)));
        const key = `${level}/${x}/${y}/${z}`;
        let bucket = tiles.get(key);
        if (!bucket) {
          bucket = new Map();
          tiles.set(key, bucket);
        }
        let list = bucket.get(g);
        if (!list) {
          list = [];
          bucket.set(g, list);
        }
        list.push(t);
      }
    }
  }
  return tiles;
}
