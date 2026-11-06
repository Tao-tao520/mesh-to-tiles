import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import { enuTransform, gltfPosition } from './enu.js';
import { createKtxPool, encodeKtx2, type KtxPool } from './ktx2.js';
import { encodeSubtree, tilesetDocument } from './tileset.js';

const MAGIC_LOW = 0x6c910ea1;
const MAGIC_HIGH = 0x1afb4545;

export interface OsgbMesh {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  image: Buffer | null;
}

interface OsgbFile {
  meshes: OsgbMesh[];
  files: { name: string; rangeMax: number }[];
  children: OsgbFile[];
  radius: number;
}

class Reader {
  private offset = 0;
  private version = 0;
  private readonly ids = new Map<number, unknown>();
  private readonly images = new Map<number, Buffer | null>();
  private readonly brackets: number[] = [];

  constructor(private readonly data: Buffer) {}

  parse(): OsgbFile {
    const low = this.data.readUInt32LE(0);
    const high = this.data.readUInt32LE(4);
    if (low !== MAGIC_LOW || high !== MAGIC_HIGH) throw new Error('Not an OSGB file.');
    this.offset = 8;
    const type = this.i32();
    this.version = this.i32();
    const attributes = this.i32();
    if (type !== 1) throw new Error(`Unsupported OSGB type ${type}.`);
    if (attributes & 0x2) throw new Error('OSGB schema blocks are not supported.');
    if (attributes & 0x1) {
      const domains = this.u32();
      for (let i = 0; i < domains; i += 1) {
        this.string();
        this.i32();
      }
    }
    const compressor = this.string();
    if (compressor !== '0') throw new Error(`Compressed OSGB (${compressor}) is not supported.`);
    const root = this.object();
    return asFile(root);
  }

  private object(): unknown {
    const className = this.string();
    if (className === 'NULL' || className === '') return null;
    const start = this.offset;
    const size = this.version > 148 ? Number(this.data.readBigUInt64LE(this.advance(8))) : this.i32();
    const end = start + size;
    const id = this.u32();
    const cached = this.ids.get(id);
    if (cached !== undefined) {
      this.offset = end;
      return cached;
    }
    const value = this.fields(className);
    if (this.offset > end) {
      throw new Error(`${className} overran its block by ${this.offset - end} bytes at ${start}.`);
    }
    this.offset = end;
    this.ids.set(id, value);
    return value;
  }

  private fields(className: string): unknown {
    if (className === 'osg::Group') return this.group();
    if (className === 'osg::PagedLOD') return this.pagedLod();
    if (className === 'osg::Geode') return this.geode();
    if (className === 'osg::Geometry') return this.geometry();
    if (className === 'osg::StateSet') return this.stateSet();
    if (className === 'osg::Material') return this.material();
    if (className === 'osg::Texture2D') return this.texture2d();
    if (className === 'osg::DefaultUserDataContainer') return this.userData();
    if (className === 'osg::UserDataContainer') return this.baseObject();
    if (className.endsWith('Array')) return this.array(className);
    if (className.startsWith('osg::DrawElements')) return this.drawElements(className);
    if (className === 'osg::DrawArrays') return this.drawArrays();
    return { kind: 'skip' };
  }

  private baseObject(): { name: string } {
    const name = this.string();
    this.i32();
    if (this.bool()) this.object();
    return { name };
  }

  private nodeTail(): Buffer | null {
    if (this.bool()) this.skipBracket();
    for (let i = 0; i < 4; i += 1) {
      if (this.bool()) this.object();
    }
    this.bool();
    this.u32();
    return this.bool() ? (this.object() as Buffer | null) : null;
  }

  private group(): OsgbFile {
    this.baseObject();
    const image = this.nodeTail();
    const children: unknown[] = [];
    if (this.bool()) {
      const count = this.u32();
      this.bracket();
      for (let i = 0; i < count; i += 1) children.push(this.object());
      this.endBracket();
    }
    return mergeFile(children, image);
  }

  private geode(): OsgbFile {
    this.baseObject();
    const stateImage = this.nodeTail();
    const meshes: OsgbMesh[] = [];
    if (this.bool()) {
      const count = this.u32();
      this.bracket();
      for (let i = 0; i < count; i += 1) {
        const geometry = this.object() as OsgbMesh[] | null;
        if (geometry) meshes.push(...geometry);
      }
      this.endBracket();
    }
    if (stateImage) {
      for (const mesh of meshes) if (!mesh.image) mesh.image = stateImage;
    }
    return { meshes, files: [], children: [], radius: radiusOf(meshes) };
  }

  private pagedLod(): OsgbFile {
    this.baseObject();
    this.nodeTail();
    this.i32();
    let center: number[] | null = null;
    let radius = 0;
    if (this.bool()) {
      center = [this.f64(), this.f64(), this.f64()];
      radius = this.f64();
    }
    const pixel = this.i32() === 1;
    const ranges: { min: number; max: number }[] = [];
    if (this.bool()) {
      const count = this.u32();
      this.bracket();
      for (let i = 0; i < count; i += 1) ranges.push({ min: this.f32(), max: this.f32() });
      this.endBracket();
    }
    this.bool();
    if (this.bool()) this.string();
    this.u32();
    this.bool();
    const files: { name: string; rangeMax: number }[] = [];
    if (this.bool()) {
      const count = this.u32();
      this.bracket();
      for (let i = 0; i < count; i += 1) {
        const name = this.string();
        if (name) files.push({ name, rangeMax: ranges[i]?.max ?? 0 });
      }
      this.endBracket();
      const priorities = this.u32();
      this.bracket();
      for (let i = 0; i < priorities; i += 1) {
        this.f32();
        this.f32();
      }
      this.endBracket();
    }
    const children: unknown[] = [];
    if (this.bool()) {
      const count = this.u32();
      if (count > 0) {
        this.bracket();
        for (let i = 0; i < count; i += 1) children.push(this.object());
        this.endBracket();
      }
    }
    const file = mergeFile(children, null);
    file.files.push(...files);
    if (!pixel && ranges.length) file.radius = Math.max(file.radius, ...ranges.map((range) => range.max));
    else if (radius > 0) file.radius = Math.max(file.radius, radius);
    void center;
    return file;
  }

  private geometry(): OsgbMesh[] {
    this.baseObject();
    const image = this.version < 154 ? this.drawableTail() : null;
    const count = this.u32();
    const primitives: { mode: number; indices: number[] }[] = [];
    for (let i = 0; i < count; i += 1) {
      const primitive = this.object() as { mode: number; indices: number[] } | null;
      if (primitive) primitives.push(primitive);
    }
    const vertexArray = this.bool() ? this.object() as Float32Array | null : null;
    if (this.bool()) this.object();
    if (this.bool()) this.object();
    if (this.bool()) this.object();
    if (this.bool()) this.object();
    const texCount = this.u32();
    let uvs: Float32Array | null = null;
    for (let i = 0; i < texCount; i += 1) {
      const array = this.object() as Float32Array | null;
      if (i === 0 && array instanceof Float32Array) uvs = array;
    }
    const attribCount = this.u32();
    for (let i = 0; i < attribCount; i += 1) this.object();
    if (!vertexArray || vertexArray.length < 3) return [];
    const uvData = uvs && uvs.length >= 2 ? uvs : new Float32Array((vertexArray.length / 3) * 2);
    const meshes: OsgbMesh[] = [];
    for (const primitive of primitives) {
      const indices = triangleIndices(primitive.mode, primitive.indices);
      if (!indices.length) continue;
      meshes.push({ positions: vertexArray, uvs: uvData, indices: Uint32Array.from(indices), image });
    }
    return meshes;
  }

  private drawableTail(): Buffer | null {
    const image = this.bool() ? (this.object() as Buffer | null) : null;
    if (this.bool()) this.skipBracket();
    if (this.bool()) this.object();
    if (this.bool()) this.object();
    this.bool();
    this.bool();
    this.bool();
    for (let i = 0; i < 4; i += 1) if (this.bool()) this.object();
    return image;
  }

  private stateSet(): Buffer | null {
    this.baseObject();
    let image: Buffer | null = null;
    if (this.bool()) this.modes();
    if (this.bool()) image = this.attributes() ?? image;
    if (this.bool()) {
      const units = this.u32();
      this.bracket();
      for (let i = 0; i < units; i += 1) this.modes();
      this.endBracket();
    }
    if (this.bool()) {
      const units = this.u32();
      this.bracket();
      for (let i = 0; i < units; i += 1) {
        const found = this.attributes();
        if (found) image = found;
      }
      this.endBracket();
    }
    if (this.bool()) {
      const count = this.u32();
      this.bracket();
      for (let i = 0; i < count; i += 1) {
        this.object();
        this.i32();
      }
      this.endBracket();
    }
    this.i32();
    this.i32();
    this.i32();
    this.string();
    this.bool();
    if (this.bool()) this.object();
    if (this.bool()) this.object();
    return image;
  }

  private modes(): void {
    const count = this.u32();
    if (!count) return;
    this.bracket();
    for (let i = 0; i < count; i += 1) {
      this.i32();
      this.i32();
    }
    this.endBracket();
  }

  private attributes(): Buffer | null {
    const count = this.u32();
    if (!count) return null;
    this.bracket();
    let image: Buffer | null = null;
    for (let i = 0; i < count; i += 1) {
      const value = this.object();
      this.i32();
      if (Buffer.isBuffer(value)) image = value;
    }
    this.endBracket();
    return image;
  }

  private material(): null {
    this.baseObject();
    if (this.bool()) this.object();
    if (this.bool()) this.object();
    this.i32();
    for (let i = 0; i < 5; i += 1) {
      if (!this.bool()) continue;
      this.bool();
      if (i === 4) {
        this.f32();
        this.f32();
      } else {
        this.skip(16);
        this.skip(16);
      }
    }
    return null;
  }

  private texture2d(): Buffer | null {
    this.baseObject();
    if (this.bool()) this.object();
    if (this.bool()) this.object();
    for (let i = 0; i < 5; i += 1) {
      if (this.bool()) this.i32();
    }
    this.f32();
    this.bool();
    this.bool();
    this.bool();
    this.bool();
    this.skip(32);
    this.i32();
    this.i32();
    if (this.bool()) this.i32();
    if (this.bool()) this.i32();
    if (this.bool()) this.i32();
    this.bool();
    this.i32();
    this.i32();
    this.f32();
    if (this.bool()) this.skip(4 + 4 + 1 + 4 + 4 + 4);
    if (this.bool()) this.string();
    const image = this.bool() ? this.image() : null;
    this.i32();
    this.i32();
    return image;
  }

  private image(): Buffer | null {
    const className = this.string();
    if (className === 'NULL') return null;
    const id = this.u32();
    if (this.images.has(id)) return this.images.get(id) ?? null;
    const fileName = this.string();
    this.i32();
    const decision = this.i32();
    let image: Buffer | null = null;
    if (decision === 0) {
      this.i32();
      const s = this.i32();
      const t = this.i32();
      this.i32();
      this.i32();
      const pixelFormat = this.i32();
      const dataType = this.i32();
      this.i32();
      this.i32();
      const size = this.u32();
      const bytes = this.take(size);
      image = rawImage(bytes, s, t, pixelFormat, dataType);
    } else if (decision === 1) {
      const size = this.u32();
      image = Buffer.from(this.take(size));
    }
    void fileName;
    if (decision === 0) {
      const levels = this.u32();
      for (let i = 0; i < levels; i += 1) this.u32();
    }
    this.baseObject();
    this.images.set(id, image);
    return image;
  }

  private array(className: string): Float32Array | Uint32Array | null {
    this.baseObject();
    if (this.version >= 147 && this.bool()) this.object();
    this.i32();
    this.bool();
    this.bool();
    const count = this.u32();
    if (className === 'osg::Vec3Array') {
      const out = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        out[i * 3] = this.f32();
        out[i * 3 + 1] = this.f32();
        out[i * 3 + 2] = this.f32();
      }
      return out;
    }
    if (className === 'osg::Vec2Array') {
      const out = new Float32Array(count * 2);
      for (let i = 0; i < count; i += 1) {
        out[i * 2] = this.f32();
        out[i * 2 + 1] = this.f32();
      }
      return out;
    }
    const width = arrayWidth(className);
    this.skip(count * width);
    return null;
  }

  private drawElements(className: string): { mode: number; indices: number[] } {
    this.baseObject();
    if (this.version >= 147 && this.bool()) this.object();
    this.i32();
    const mode = this.i32();
    const count = this.u32();
    const indices: number[] = [];
    for (let i = 0; i < count; i += 1) {
      if (className.endsWith('UInt')) indices.push(this.u32());
      else if (className.endsWith('UShort')) indices.push(this.u16());
      else indices.push(this.u8());
    }
    return { mode, indices };
  }

  private drawArrays(): { mode: number; indices: number[] } {
    this.baseObject();
    if (this.version >= 147 && this.bool()) this.object();
    this.i32();
    const mode = this.i32();
    const first = this.i32();
    const count = this.i32();
    const indices: number[] = [];
    for (let i = 0; i < count; i += 1) indices.push(first + i);
    return { mode, indices };
  }

  private userData(): null {
    this.baseObject();
    if (this.bool()) {
      this.bracket();
      this.object();
      this.endBracket();
    }
    if (this.bool()) {
      const count = this.u32();
      this.bracket();
      for (let i = 0; i < count; i += 1) this.string();
      this.endBracket();
    }
    if (this.bool()) {
      const count = this.u32();
      this.bracket();
      for (let i = 0; i < count; i += 1) this.object();
      this.endBracket();
    }
    return null;
  }

  private skipBracket(): void {
    this.bracket();
    this.offset = this.brackets.pop() ?? this.offset;
  }

  private bracket(): void {
    const start = this.offset;
    const size = this.version > 148 ? Number(this.data.readBigUInt64LE(this.advance(8))) : this.i32();
    this.brackets.push(start + size);
  }

  private endBracket(): void {
    const end = this.brackets.pop();
    if (end === undefined) throw new Error('Unbalanced OSGB block.');
    if (this.offset > end) throw new Error(`OSGB block overrun at ${this.offset}.`);
    this.offset = end;
  }

  private bool(): boolean {
    return this.u8() !== 0;
  }

  private string(): string {
    const size = this.i32();
    if (size < 0) throw new Error('Negative OSGB string.');
    const start = this.offset;
    this.advance(size);
    return this.data.toString('utf8', start, this.offset);
  }

  private take(size: number): Buffer {
    const start = this.offset;
    this.advance(size);
    return this.data.subarray(start, start + size);
  }

  private skip(size: number): void {
    this.advance(size);
  }

  private advance(size: number): number {
    if (this.offset + size > this.data.length) throw new Error(`OSGB truncated at ${this.offset}.`);
    const current = this.offset;
    this.offset += size;
    return current;
  }

  private u8(): number { return this.data.readUInt8(this.advance(1)); }
  private u16(): number { return this.data.readUInt16LE(this.advance(2)); }
  private i32(): number { return this.data.readInt32LE(this.advance(4)); }
  private u32(): number { return this.data.readUInt32LE(this.advance(4)); }
  private f32(): number { return this.data.readFloatLE(this.advance(4)); }
  private f64(): number { return this.data.readDoubleLE(this.advance(8)); }
}

function arrayWidth(className: string): number {
  if (className.includes('Vec4d') || className.includes('Matrix')) return 32;
  if (className.includes('Vec3d')) return 24;
  if (className.includes('Vec2d') || className.includes('Vec4')) return 16;
  if (className.includes('Vec3')) return 12;
  if (className.includes('Vec2') || className.includes('Double') || className === 'osg::UIntArray' || className === 'osg::IntArray' || className === 'osg::FloatArray') return 8;
  if (className.includes('Short') || className.includes('UShort')) return 2;
  return 4;
}

function triangleIndices(mode: number, indices: number[]): number[] {
  const out: number[] = [];
  if (mode === 4) {
    for (let i = 0; i + 2 < indices.length; i += 3) out.push(indices[i], indices[i + 1], indices[i + 2]);
  } else if (mode === 5) {
    for (let i = 0; i + 2 < indices.length; i += 1) {
      if (i % 2 === 0) out.push(indices[i], indices[i + 1], indices[i + 2]);
      else out.push(indices[i + 1], indices[i], indices[i + 2]);
    }
  } else if (mode === 6) {
    for (let i = 1; i + 1 < indices.length; i += 1) out.push(indices[0], indices[i], indices[i + 1]);
  } else if (mode === 7) {
    for (let i = 0; i + 3 < indices.length; i += 4) out.push(indices[i], indices[i + 1], indices[i + 2], indices[i], indices[i + 2], indices[i + 3]);
  }
  return out;
}

function mergeFile(children: unknown[], image: Buffer | null): OsgbFile {
  const file: OsgbFile = { meshes: [], files: [], children: [], radius: 0 };
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const node = child as OsgbFile;
    if (!node.meshes || !node.files) continue;
    if (image) for (const mesh of node.meshes) if (!mesh.image) mesh.image = image;
    file.meshes.push(...node.meshes);
    file.files.push(...node.files);
    file.children.push(...node.children);
    file.radius = Math.max(file.radius, node.radius);
  }
  file.radius = Math.max(file.radius, radiusOf(file.meshes));
  return file;
}

function asFile(value: unknown): OsgbFile {
  if (value && typeof value === 'object' && 'meshes' in value) return value as OsgbFile;
  return { meshes: [], files: [], children: [], radius: 1 };
}

function radiusOf(meshes: OsgbMesh[]): number {
  let max = 0;
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const r = Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
      if (r > max) max = r;
    }
  }
  return max;
}

function rawImage(bytes: Buffer, width: number, height: number, pixelFormat: number, dataType: number): Buffer | null {
  if (width <= 0 || height <= 0 || dataType !== 0x1401) return bytes.length ? Buffer.from(bytes) : null;
  const channels = pixelFormat === 0x1907 ? 3 : pixelFormat === 0x1908 ? 4 : 0;
  if (!channels) return Buffer.from(bytes);
  return Buffer.from(bytes.subarray(0, width * height * channels));
}

interface Meta {
  srs: string;
  x: number;
  y: number;
  z: number;
}

function readMetadata(dir: string): Meta {
  const file = path.join(dir, 'metadata.xml');
  if (!fs.existsSync(file)) throw new Error(`No metadata.xml in ${dir}`);
  const xml = fs.readFileSync(file, 'utf8');
  const srs = xml.match(/<(?:SRS|CoordSys)>\s*([^<]+)\s*</)?.[1]?.trim() ?? '';
  const origin = xml.match(/<SRSOrigin>\s*([^<]+)\s*</)?.[1];
  let x = 0;
  let y = 0;
  let z = 0;
  if (origin) {
    const parts = origin.trim().split(/[,\s]+/).map(Number);
    [x, y, z] = parts;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('metadata.xml has no origin.');
  return { srs, x, y, z };
}

function utmToLonLat(easting: number, northing: number, zone: number, northern: boolean): { lon: number; lat: number } {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const x = easting - 500000;
  const y = northern ? northing : northing - 10000000;
  const mu = y / k0 / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const t1 = Math.tan(phi1) ** 2;
  const c1 = ep2 * cos1 * cos1;
  const n1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const r1 = a * (1 - e2) / (1 - e2 * sin1 * sin1) ** 1.5;
  const d = x / (n1 * k0);
  const lat = phi1 - (n1 * Math.tan(phi1) / r1) * (
    d * d / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720
  );
  const lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / cos1;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  return { lon: ((lon + lon0) * 180) / Math.PI, lat: (lat * 180) / Math.PI };
}

function originLonLat(meta: Meta): { longitude: number; latitude: number; height: number } {
  const utm = meta.srs.match(/^EPSG:32([67])(\d{2})$/);
  if (!utm) throw new Error(`Unsupported SRS ${meta.srs}. This step supports WGS84 UTM (EPSG:326xx / 327xx).`);
  const zone = Number(utm[2]);
  const { lon, lat } = utmToLonLat(meta.x, meta.y, zone, utm[1] === '6');
  return { longitude: lon, latitude: lat, height: meta.z };
}

interface Bounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
}

function addPoint(bounds: Bounds, x: number, y: number, z: number): void {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.maxZ = Math.max(bounds.maxZ, z);
}

function boundsOfMeshes(meshes: OsgbMesh[], bounds = emptyBounds()): Bounds {
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i += 3) addPoint(bounds, mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
  }
  return bounds;
}

interface PageNode {
  cache: string | null;
  cx: number;
  cy: number;
  cz: number;
  children: PageNode[];
}

function unpackMeshes(data: Buffer): OsgbMesh[] {
  let offset = 0;
  const count = data.readUInt32LE(offset);
  offset += 4;
  const meshes: OsgbMesh[] = [];
  for (let i = 0; i < count; i += 1) {
    const posLen = data.readUInt32LE(offset);
    const uvLen = data.readUInt32LE(offset + 4);
    const indexLen = data.readUInt32LE(offset + 8);
    const imageLen = data.readUInt32LE(offset + 12);
    offset += 16;
    const positions = new Float32Array(posLen);
    Buffer.from(positions.buffer).set(data.subarray(offset, offset + posLen * 4));
    offset += posLen * 4;
    const uvs = new Float32Array(uvLen);
    Buffer.from(uvs.buffer).set(data.subarray(offset, offset + uvLen * 4));
    offset += uvLen * 4;
    const indices = new Uint32Array(indexLen);
    Buffer.from(indices.buffer).set(data.subarray(offset, offset + indexLen * 4));
    offset += indexLen * 4;
    const image = imageLen ? Buffer.from(data.subarray(offset, offset + imageLen)) : null;
    offset += imageLen;
    meshes.push({ positions, uvs, indices, image });
  }
  return meshes;
}

async function imageBytes(image: Buffer | null): Promise<{ data: Buffer; mime: string } | null> {
  if (!image || image.length < 16) return null;
  if (image[0] === 0xff && image[1] === 0xd8) return { data: image, mime: 'image/jpeg' };
  if (image[0] === 0x89 && image[1] === 0x50) return { data: image, mime: 'image/png' };
  if (image.length % 4 === 0) {
    const pixels = Math.round(Math.sqrt(image.length / 4));
    if (pixels * pixels * 4 === image.length) {
      return { data: await sharp(image, { raw: { width: pixels, height: pixels, channels: 4 } }).jpeg().toBuffer(), mime: 'image/jpeg' };
    }
  }
  if (image.length % 3 === 0) {
    const pixels = Math.round(Math.sqrt(image.length / 3));
    if (pixels * pixels * 3 === image.length) {
      return { data: await sharp(image, { raw: { width: pixels, height: pixels, channels: 3 } }).jpeg().toBuffer(), mime: 'image/jpeg' };
    }
  }
  return { data: image, mime: 'image/jpeg' };
}

async function writeGlb(meshes: OsgbMesh[], io: NodeIO, ktxPool: KtxPool | null, texLimit: number, outputUp: 'y' | 'z'): Promise<Buffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const unlit = doc.createExtension(KHRMaterialsUnlit).createUnlit();
  const scene = doc.createScene();
  const node = doc.createNode();
  const mesh = doc.createMesh();
  scene.addChild(node);
  node.setMesh(mesh);
  for (const source of meshes) {
    const positions = new Float32Array(source.positions.length);
    for (let i = 0; i < source.positions.length; i += 3) {
      const [gx, gy, gz] = gltfPosition(outputUp, source.positions[i], source.positions[i + 1], source.positions[i + 2]);
      positions[i] = gx;
      positions[i + 1] = gy;
      positions[i + 2] = gz;
    }
    const uvs = new Float32Array(source.uvs.length);
    for (let i = 0; i < source.uvs.length; i += 2) {
      uvs[i] = source.uvs[i];
      uvs[i + 1] = 1 - source.uvs[i + 1];
    }
    const prim = doc.createPrimitive();
    prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer));
    prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer));
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(source.indices).setBuffer(buffer));
    const material = doc.createMaterial().setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(1);
    material.setExtension('KHR_materials_unlit', unlit);
    const encoded = await imageBytes(source.image);
    if (encoded) {
      const texture = doc.createTexture('baseColor');
      texture.setImage(encoded.data);
      texture.setMimeType(encoded.mime);
      material.setBaseColorTexture(texture);
    }
    prim.setMaterial(material);
    mesh.addPrimitive(prim);
  }
  if (ktxPool) await encodeKtx2(doc, ktxPool, texLimit);
  await doc.transform(draco({ method: 'sequential', quantizePosition: 14, quantizeTexcoord: 12 }));
  return Buffer.from(await io.writeBinary(doc));
}

function packMeshes(meshes: OsgbMesh[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(meshes.length, 0);
  for (const mesh of meshes) {
    const head = Buffer.alloc(16);
    head.writeUInt32LE(mesh.positions.length, 0);
    head.writeUInt32LE(mesh.uvs.length, 4);
    head.writeUInt32LE(mesh.indices.length, 8);
    head.writeUInt32LE(mesh.image?.length ?? 0, 12);
    parts.push(
      head,
      Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
      Buffer.from(mesh.uvs.buffer, mesh.uvs.byteOffset, mesh.uvs.byteLength),
      Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
    );
    if (mesh.image) parts.push(mesh.image);
  }
  return Buffer.concat(parts);
}

function hasOsgb(dir: string): boolean {
  return fs.existsSync(dir) && fs.readdirSync(dir).some((name) => name.toLowerCase().endsWith('.osgb'));
}

function resolveOsgbDir(inputDir: string): { dataDir: string; metaDir: string } {
  let dataDir = inputDir;
  if (!hasOsgb(inputDir)) {
    const subs = fs.readdirSync(inputDir).filter((name) => fs.statSync(path.join(inputDir, name)).isDirectory());
    const only = subs.length === 1 ? path.join(inputDir, subs[0]) : '';
    const data = path.join(inputDir, 'Data');
    if (only && hasOsgb(only)) dataDir = only;
    else if (hasOsgb(data)) dataDir = data;
  }
  const metaDir = [dataDir, inputDir, path.dirname(dataDir)].find((dir) => fs.existsSync(path.join(dir, 'metadata.xml'))) ?? dataDir;
  return { dataDir, metaDir };
}

function rootOsgbNames(dataDir: string): string[] {
  const files = fs.readdirSync(dataDir).filter((name) => {
    const full = path.join(dataDir, name);
    return name.toLowerCase().endsWith('.osgb') && fs.statSync(full).isFile();
  });
  for (const preferred of ['Data.osgb', 'tileset.osgb', 'Block.osgb']) {
    const found = files.find((name) => name.toLowerCase() === preferred.toLowerCase());
    if (found) return [found];
  }
  if (files.length && files.every((name) => /^\d+\.osgb$/i.test(name))) {
    return [files.reduce((shortest, name) => (name.length < shortest.length ? name : shortest))];
  }
  return files;
}

function collect(file: OsgbFile, osgbPath: string, cacheDir: string, scene: Bounds, seq: { n: number }): PageNode {
  let cache: string | null = null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  if (file.meshes.length) {
    const bounds = boundsOfMeshes(file.meshes);
    addPoint(scene, bounds.minX, bounds.minY, bounds.minZ);
    addPoint(scene, bounds.maxX, bounds.maxY, bounds.maxZ);
    cx = (bounds.minX + bounds.maxX) / 2;
    cy = (bounds.minY + bounds.maxY) / 2;
    cz = (bounds.minZ + bounds.maxZ) / 2;
    cache = `${seq.n}.bin`;
    seq.n += 1;
    fs.writeFileSync(path.join(cacheDir, cache), packMeshes(file.meshes));
  }
  const children: PageNode[] = [];
  for (const link of file.files) {
    const next = path.resolve(path.dirname(osgbPath), link.name);
    if (!fs.existsSync(next)) continue;
    children.push(collect(new Reader(fs.readFileSync(next)).parse(), next, cacheDir, scene, seq));
  }
  return { cache, cx, cy, cz, children };
}

function cellBox(level: number, x: number, y: number, scene: Bounds): Bounds {
  const div = 2 ** level;
  const sx = (scene.maxX - scene.minX) / div;
  const sy = (scene.maxY - scene.minY) / div;
  return {
    minX: scene.minX + x * sx,
    minY: scene.minY + y * sy,
    minZ: scene.minZ,
    maxX: scene.minX + (x + 1) * sx,
    maxY: scene.minY + (y + 1) * sy,
    maxZ: scene.maxZ,
  };
}

function place(
  node: PageNode,
  parentLevel: number,
  parentX: number,
  parentY: number,
  scene: Bounds,
  groups: Map<string, string[]>,
  depth: { max: number },
): void {
  if (!node.cache && parentLevel < 0) {
    if (node.children.length === 1) {
      place(node.children[0], -1, 0, 0, scene, groups, depth);
      return;
    }
    for (const child of node.children) place(child, 0, 0, 0, scene, groups, depth);
    return;
  }
  let level = parentLevel;
  let x = parentX;
  let y = parentY;
  if (node.cache) {
    if (parentLevel < 0) {
      level = 0;
      x = 0;
      y = 0;
    } else {
      const box = cellBox(parentLevel, parentX, parentY, scene);
      const east = node.cx >= (box.minX + box.maxX) / 2 ? 1 : 0;
      const north = node.cy >= (box.minY + box.maxY) / 2 ? 1 : 0;
      level = parentLevel + 1;
      x = parentX * 2 + east;
      y = parentY * 2 + north;
    }
    depth.max = Math.max(depth.max, level);
    const key = `${level}/${x}/${y}`;
    const list = groups.get(key);
    if (list) list.push(node.cache);
    else groups.set(key, [node.cache]);
  }
  for (const child of node.children) place(child, level, x, y, scene, groups, depth);
}

function withAncestors(content: Set<string>): Set<string> {
  const tiles = new Set<string>();
  for (const key of content) {
    let [level, x, y] = key.split('/').map(Number);
    while (level >= 0) {
      tiles.add(`${level}/${x}/${y}`);
      level -= 1;
      x >>= 1;
      y >>= 1;
    }
  }
  return tiles;
}

function texLimit(level: number, maxLevel: number): number {
  const hops = maxLevel - level;
  if (hops <= 0) return 2048;
  if (hops === 1) return 1024;
  return 512;
}

export async function convertOsgb(inputDir: string, outputDir: string, ktx2 = true, outputUp: 'y' | 'z' = 'y', ktxLevel = 2): Promise<void> {
  const started = Date.now();
  const located = resolveOsgbDir(inputDir);
  const meta = readMetadata(located.metaDir);
  const georef = originLonLat(meta);
  const roots = rootOsgbNames(located.dataDir);
  if (!roots.length) throw new Error(`No .osgb files in ${located.dataDir}`);
  const cacheDir = path.join(outputDir, '.cache');
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const bounds = emptyBounds();
  const seq = { n: 0 };
  const pages: PageNode[] = [];
  for (const name of roots) {
    const osgbPath = path.join(located.dataDir, name);
    pages.push(collect(new Reader(fs.readFileSync(osgbPath)).parse(), osgbPath, cacheDir, bounds, seq));
  }
  const pad = 0.01;
  bounds.minX -= pad;
  bounds.minY -= pad;
  bounds.minZ -= pad;
  bounds.maxX += pad;
  bounds.maxY += pad;
  bounds.maxZ += pad;
  const groups = new Map<string, string[]>();
  const depth = { max: 0 };
  for (const page of pages) place(page, -1, 0, 0, bounds, groups, depth);
  const content = new Set(groups.keys());
  const available = withAncestors(content);
  const maxLevel = depth.max;
  const levels = maxLevel + 1;
  const rootError = 2 ** maxLevel;
  console.log(`OSGB ${meta.srs} origin ${georef.longitude.toFixed(6)}, ${georef.latitude.toFixed(6)}, ${georef.height.toFixed(2)}`);
  console.log(`OSGB root ${roots.join(', ')} from ${located.dataDir}`);
  console.log(`Implicit quadtree levels=${levels} tiles=${content.size} nodes=${seq.n} rootError=${rootError}`);

  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression, KHRMaterialsUnlit, KHRTextureBasisu])
    .registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
    });
  const parallel = Math.max(1, Math.min(16, os.availableParallelism()));
  const ktxPool = ktx2 ? createKtxPool(parallel, ktxLevel) : null;
  const jobs = [...groups.entries()];
  let written = 0;
  for (let start = 0; start < jobs.length; start += parallel) {
    const batch = jobs.slice(start, start + parallel);
    await Promise.all(batch.map(async ([key, caches]) => {
      const meshes = caches.flatMap((name) => unpackMeshes(fs.readFileSync(path.join(cacheDir, name))));
      if (!meshes.length) return;
      const [level, x, y] = key.split('/');
      const dest = path.join(outputDir, 'tiles', level, x, `${y}.glb`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await writeGlb(meshes, io, ktxPool, texLimit(Number(level), maxLevel), outputUp));
      written += 1;
      if (written % 25 === 0) console.log(`  ${written}/${jobs.length}`);
    }));
  }
  if (ktxPool) await ktxPool.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const subtree = encodeSubtree(maxLevel, available, content, 'QUADTREE');
  fs.mkdirSync(path.join(outputDir, 'subtrees', '0', '0'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'subtrees', '0', '0', '0.subtree'), subtree);
  const tileset = tilesetDocument(bounds, rootError, levels, georef, 'QUADTREE');
  fs.writeFileSync(path.join(outputDir, 'tileset.json'), JSON.stringify(tileset));
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`Done. ${written} tiles, ${seconds}s -> ${outputDir}`);
}
