import sharp from 'sharp';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

interface BasisEncoder {
  setCreateKTX2File(v: boolean): void;
  setKTX2UASTCSupercompression(v: boolean): void;
  setKTX2SRGBTransferFunc(v: boolean): void;
  setPerceptual(v: boolean): void;
  setMipSRGB(v: boolean): void;
  setQualityLevel(level: number): void;
  setCompressionLevel(level: number): void;
  setNoSelectorRDO(v: boolean): void;
  setNoEndpointRDO(v: boolean): void;
  setUASTC(v: boolean): void;
  setMipGen(v: boolean): void;
  setSliceSourceImage(slice: number, data: Uint8Array, w: number, h: number, alpha: boolean): void;
  encode(output: Uint8Array): number;
  delete(): void;
}

interface BasisModule {
  BasisEncoder: new () => BasisEncoder;
  initializeBasis(): void;
}

let basisPromise: Promise<BasisModule> | null = null;

function loadBasis(): Promise<BasisModule> {
  if (basisPromise) return basisPromise;
  basisPromise = (async () => {
    const nodeRequire = createRequire(import.meta.url);
    const entry = nodeRequire.resolve('@loaders.gl/textures');
    const libDir = path.join(path.dirname(entry), 'libs');
    const jsCode = fs.readFileSync(path.join(libDir, 'basis_encoder.js'), 'utf8');
    const wasm = fs.readFileSync(path.join(libDir, 'basis_encoder.wasm'));
    const sandbox: { exports: unknown } = { exports: {} };
    const wrapper = new Function('module', 'exports', 'require', '__filename', '__dirname', jsCode);
    wrapper(sandbox, sandbox.exports, nodeRequire, path.join(libDir, 'basis_encoder.js'), libDir);
    const createModule = sandbox.exports as (opts: { wasmBinary: ArrayBuffer }) => Promise<BasisModule>;
    const basis = await createModule({ wasmBinary: wasm.buffer });
    basis.initializeBasis();
    sharp.concurrency(1);
    return basis;
  })();
  return basisPromise;
}

function encodePixels(
  basis: BasisModule,
  rgba: Uint8Array,
  width: number,
  height: number,
  quality: number,
  compressionLevel: number,
  uastc: boolean,
  zstd: boolean,
): Uint8Array {
  const encoder = new basis.BasisEncoder();
  try {
    encoder.setCreateKTX2File(true);
    encoder.setKTX2SRGBTransferFunc(true);
    encoder.setPerceptual(true);
    encoder.setMipSRGB(true);
    encoder.setQualityLevel(quality);
    encoder.setCompressionLevel(compressionLevel);
    encoder.setNoEndpointRDO(true);
    encoder.setNoSelectorRDO(true);
    encoder.setUASTC(uastc);
    encoder.setKTX2UASTCSupercompression(zstd);
    encoder.setMipGen(false);
    encoder.setSliceSourceImage(0, rgba, width, height, false);
    const output = new Uint8Array(Math.max(width * height * 4, 4096));
    const bytes = encoder.encode(output);
    if (!bytes) throw new Error('BasisEncoder returned 0 bytes');
    return output.slice(0, bytes);
  } finally {
    encoder.delete();
  }
}

export async function encodeRgbaToKtx2(
  rgba: Uint8Array,
  width: number,
  height: number,
  quality = 128,
  compressionLevel = 2,
  uastc = false,
  zstd = false,
): Promise<Uint8Array> {
  return encodePixels(await loadBasis(), rgba, width, height, quality, compressionLevel, uastc, zstd);
}

export async function encodeImageToKtx2(
  image: Uint8Array,
  maxSize: number | undefined,
  quality = 128,
  compressionLevel = 2,
  uastc = false,
  zstd = false,
): Promise<Uint8Array> {
  let pipeline = sharp(image).rotate().ensureAlpha();
  if (maxSize) pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
  const decoded = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return encodePixels(await loadBasis(), decoded.data, decoded.info.width, decoded.info.height, quality, compressionLevel, uastc, zstd);
}
