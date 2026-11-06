import { Worker } from 'node:worker_threads';
import { Document } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import sharp from 'sharp';
import type { TextureSettings } from './texture.js';

interface BusyWorker extends Worker {
  busy: boolean;
}

export interface KtxPool {
  encode(rgba: Uint8Array, width: number, height: number): Promise<Buffer>;
  encodeImage(image: Buffer, maxSize: number): Promise<Buffer>;
  close(): Promise<unknown>;
}

export function createKtxPool(size: number, settings: TextureSettings): KtxPool {
  const workers: BusyWorker[] = Array.from({ length: size }, () => {
    const worker = new Worker(new URL('./ktx2-worker.js', import.meta.url)) as BusyWorker;
    worker.busy = false;
    return worker;
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (buf: Buffer) => void; reject: (err: Error) => void }>();
  const queue: { message: object; transfer: ArrayBuffer[] }[] = [];
  const dispatch = (worker: BusyWorker) => {
    if (worker.busy) return;
    const job = queue.shift();
    if (!job) return;
    worker.busy = true;
    worker.postMessage(job.message, job.transfer);
  };
  for (const worker of workers) {
    worker.on('message', (msg: { id: number; error?: string; data?: Uint8Array }) => {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      worker.busy = false;
      if (!waiter) return;
      if (msg.error) waiter.reject(new Error(msg.error));
      else waiter.resolve(Buffer.from(msg.data as Uint8Array));
      dispatch(worker);
    });
    worker.on('error', (err) => {
      worker.busy = false;
      for (const waiter of pending.values()) waiter.reject(err);
      pending.clear();
    });
  }
  return {
    encode(rgba, width, height) {
      const id = nextId;
      nextId += 1;
      const copy = new Uint8Array(rgba.byteLength);
      copy.set(rgba);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        queue.push({
          message: {
            id,
            rgba: copy.buffer,
            width,
            height,
            quality: settings.ktx2Quality,
            compressionLevel: settings.ktxLevel,
            uastc: settings.uastc,
            zstd: settings.zstdLevel > 0,
          },
          transfer: [copy.buffer],
        });
        for (const worker of workers) dispatch(worker);
      });
    },
    encodeImage(image, maxSize) {
      const id = nextId;
      nextId += 1;
      const copy = new Uint8Array(image.byteLength);
      copy.set(image);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        queue.push({
          message: {
            id,
            image: copy.buffer,
            maxSize,
            quality: settings.ktx2Quality,
            compressionLevel: settings.ktxLevel,
            uastc: settings.uastc,
            zstd: settings.zstdLevel > 0,
          },
          transfer: [copy.buffer],
        });
        for (const worker of workers) dispatch(worker);
      });
    },
    close() {
      return Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}

export async function encodeKtx2(doc: Document, pool: KtxPool, maxSize?: number): Promise<void> {
  doc.createExtension(KHRTextureBasisu).setRequired(true);
  const textures = doc.getRoot().listTextures();
  const encoded = await Promise.all(textures.map(async (texture) => {
    const image = texture.getImage();
    if (!image) throw new Error('Texture has no image.');
    if (maxSize) return { texture, ktx: await pool.encodeImage(Buffer.from(image), maxSize) };
    const decoded = await sharp(Buffer.from(image)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ktx = await pool.encode(decoded.data, decoded.info.width, decoded.info.height);
    return { texture, ktx };
  }));
  for (const item of encoded) item.texture.setImage(item.ktx).setMimeType('image/ktx2');
}
