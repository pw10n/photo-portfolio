// PUBLIC_ASSETS_BASE_URL is injected at build time by astro.config.mjs from
// either process.env (.env) or <content_root>/site.yaml's assets_base_url.
// Keep this file free of Node-only imports so it can safely be bundled into
// client-side React islands.

const assetsBase = ((import.meta.env.PUBLIC_ASSETS_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');

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
