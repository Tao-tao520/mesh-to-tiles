import sharp from 'sharp';

export interface TextureSettings {
  format: 'jpeg' | 'webp' | 'ktx2';
  quality: number;
  fineQuality: number;
  maxSize: number;
  ktx2Quality: number;
  uastc: boolean;
  threads: number;
  zstdLevel: number;
  ktxLevel: number;
}

export function rasterQuality(settings: TextureSettings, level: number, maxLevel: number): number {
  if (level === maxLevel && settings.fineQuality > 0) return settings.fineQuality;
  return settings.quality;
}

export function limitTextureSize(size: number, settings: TextureSettings): number {
  if (settings.maxSize <= 0) return size;
  return Math.min(size, settings.maxSize);
}

export async function encodeRaster(image: Buffer, format: 'jpeg' | 'webp', quality: number, maxSize: number): Promise<Buffer> {
  let pipeline = sharp(image).rotate();
  if (maxSize > 0) pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
  if (format === 'webp') return pipeline.webp({ quality }).toBuffer();
  return pipeline.jpeg({ quality }).toBuffer();
}
