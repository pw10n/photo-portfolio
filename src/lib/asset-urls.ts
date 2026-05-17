const DEFAULT_ASSETS_BASE = 'https://assets.prenticew.com';

const assetsBase = (
  import.meta.env.PUBLIC_ASSETS_BASE_URL || DEFAULT_ASSETS_BASE
).replace(/\/+$/, '');

export type ImageFormat = 'avif' | 'webp' | 'jpg';

export function derivativeUrl(
  imageId: string,
  width: number,
  format: ImageFormat,
): string {
  return `${assetsBase}/derivatives/${imageId}/${width}.${format}`;
}

export function thumbUrl(imageId: string, format: ImageFormat): string {
  return `${assetsBase}/derivatives/${imageId}/thumb.${format}`;
}

export function originalUrl(imageId: string, filename: string): string {
  return `${assetsBase}/originals/${imageId}/${encodeURIComponent(filename)}`;
}
