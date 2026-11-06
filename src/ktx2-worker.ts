import { parentPort } from 'node:worker_threads';
import { encodeImageToKtx2, encodeRgbaToKtx2 } from './basis-encode.js';

interface Job {
  id: number;
  rgba?: ArrayBuffer;
  width?: number;
  height?: number;
  image?: ArrayBuffer;
  maxSize?: number;
  quality: number;
  compressionLevel: number;
  uastc: boolean;
  zstd: boolean;
}

if (!parentPort) throw new Error('ktx2-worker must be started as a worker.');

parentPort.on('message', (msg: Job) => {
  const task = msg.image
    ? encodeImageToKtx2(new Uint8Array(msg.image), msg.maxSize, msg.quality, msg.compressionLevel, msg.uastc, msg.zstd)
    : encodeRgbaToKtx2(new Uint8Array(msg.rgba as ArrayBuffer), msg.width as number, msg.height as number, msg.quality, msg.compressionLevel, msg.uastc, msg.zstd);
  void task.then((data) => {
    parentPort?.postMessage({ id: msg.id, data }, [data.buffer as ArrayBuffer]);
  }).catch((err: Error) => {
    parentPort?.postMessage({ id: msg.id, error: err.message });
  });
});
