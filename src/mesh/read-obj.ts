import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { MaterialGroup, MeshData } from '../types.js';

export function toZUp(up: 'z' | 'y', x: number, y: number, z: number): [number, number, number] {
  if (up === 'z') return [x, y, z];
  return [x, -z, y];
}

function readMtl(mtlPath: string, dir: string): Map<string, string> {
  const map = new Map<string, string>();
  let name: string | null = null;
  for (const line of fs.readFileSync(mtlPath, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('newmtl ')) name = line.slice(7).trim();
    else if (line.startsWith('map_Kd ') && name) map.set(name, path.resolve(dir, line.slice(7).trim()));
  }
  return map;
}

export async function readObj(objPath: string, up: 'z' | 'y'): Promise<MeshData> {
  const dir = path.dirname(objPath);
  const positions: number[][] = [];
  const uvs: number[] = [];
  const groups = new Map<string, MaterialGroup>();
  let mtl = new Map<string, string>();
  let current: MaterialGroup | null = null;
  const lines = readline.createInterface({
    input: fs.createReadStream(objPath),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      positions.push(toZUp(up, Number(p[1]), Number(p[2]), Number(p[3])));
    } else if (line.startsWith('vt ')) {
      const p = line.split(/\s+/);
      uvs.push(Number(p[1]), Number(p[2]));
    } else if (line.startsWith('mtllib ')) {
      mtl = readMtl(path.join(dir, line.slice(7).trim()), dir);
    } else if (line.startsWith('usemtl ')) {
      const name = line.slice(7).trim();
      current = groups.get(name) ?? null;
      if (!current) {
        const image = mtl.get(name);
        if (!image) throw new Error(`Material ${name} has no map_Kd.`);
        current = { name, image, corners: [] };
        groups.set(name, current);
      }
    } else if (line.startsWith('f ')) {
      if (!current) throw new Error('Face before usemtl.');
      const parts = line.trim().split(/\s+/).slice(1);
      const face = parts.map((part) => {
        const [vi, ti] = part.split('/');
        return [Number(vi) - 1, Number(ti) - 1];
      });
      for (let i = 1; i < face.length - 1; i += 1) {
        current.corners.push(face[0][0], face[0][1], face[i][0], face[i][1], face[i + 1][0], face[i + 1][1]);
      }
    }
  }
  return { positions, uvs, groups: [...groups.values()] };
}
