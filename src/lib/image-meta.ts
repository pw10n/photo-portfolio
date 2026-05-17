import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config';

export type ImageMetaEntry = {
  width: number;
  height: number;
  formats: ('avif' | 'webp' | 'jpg')[];
  widths: number[];
  exif?: {
    make?: string;
    model?: string;
    lens?: string;
    aperture?: string;
    iso?: number;
    shutter?: string;
    focal_length?: string;
    date_taken?: string;
  };
};

export type ImageMeta = Record<string, ImageMetaEntry>;

let cache: ImageMeta | null = null;

export async function loadImageMeta(): Promise<ImageMeta> {
  if (cache) return cache;
  const { buildDir } = loadConfig();
  const metaPath = resolve(buildDir, 'image-meta.json');
  try {
    const buf = await readFile(metaPath, 'utf8');
    cache = JSON.parse(buf) as ImageMeta;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') {
      cache = {};
    } else {
      throw err;
    }
  }
  return cache;
}

export async function getImageMeta(imageId: string): Promise<ImageMetaEntry | undefined> {
  const meta = await loadImageMeta();
  return meta[imageId];
}
