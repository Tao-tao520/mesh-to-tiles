import { parentPort } from 'node:worker_threads';
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

const nodeRequire = createRequire(import.meta.url);
const entry = nodeRequire.resolve('@loaders.gl/textures');
const libDir = path.join(path.dirname(entry), 'libs');
const jsPath = path.join(libDir, 'basis_encoder.js');
const wasm = fs.readFileSync(path.join(libDir, 'basis_encoder.wasm'));
const jsCode = fs.readFileSync(jsPath, 'utf8');
const sandbox: { exports: unknown } = { exports: {} };
const wrapper = new Function('module', 'exports', 'require', '__filename', '__dirname', jsCode);
wrapper(sandbox, sandbox.exports, nodeRequire, jsPath, libDir);
const createModule = sandbox.exports as (opts: { wasmBinary: ArrayBuffer }) => Promise<BasisModule>;
const basis = await createModule({ wasmBinary: wasm.buffer });
basis.initializeBasis();

interface Job {
  id: number;
  rgba: ArrayBuffer;
  width: number;
  height: number;
  quality: number;
}

if (!parentPort) throw new Error('ktx2-worker must be started as a worker.');

parentPort.on('message', (msg: Job) => {
  const encoder = new basis.BasisEncoder();
  try {
    encoder.setCreateKTX2File(true);
    encoder.setKTX2UASTCSupercompression(false);
    encoder.setKTX2SRGBTransferFunc(true);
    encoder.setPerceptual(true);
    encoder.setMipSRGB(true);
    encoder.setQualityLevel(msg.quality);
    encoder.setUASTC(false);
    encoder.setMipGen(false);
    encoder.setSliceSourceImage(0, new Uint8Array(msg.rgba), msg.width, msg.height, false);
    const output = new Uint8Array(Math.max(msg.width * msg.height * 4, 4096));
    const bytes = encoder.encode(output);
    if (!bytes) {
      parentPort?.postMessage({ id: msg.id, error: 'BasisEncoder returned 0 bytes' });
      return;
    }
    const data = output.slice(0, bytes);
    parentPort?.postMessage({ id: msg.id, data }, [data.buffer]);
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: (err as Error).message });
  } finally {
    encoder.delete();
  }
});
