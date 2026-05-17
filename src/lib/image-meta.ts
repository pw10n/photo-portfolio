import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const here = dirname(fileURLToPath(import.meta.url));
const META_PATH = resolve(here, '../../build/image-meta.json');

let cache: ImageMeta | null = null;

export async function loadImageMeta(): Promise<ImageMeta> {
  if (cache) return cache;
  try {
    const buf = await readFile(META_PATH, 'utf8');
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

export async function getImageMeta(
  imageId: string,
): Promise<ImageMetaEntry | undefined> {
  const meta = await loadImageMeta();
  return meta[imageId];
}
