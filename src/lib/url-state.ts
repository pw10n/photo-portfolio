const IMAGE_KEY_RE = /^i-([A-Za-z0-9]+)$/;
const NATIVE_IMAGE_ID_RE = /^[a-z2-7]{11}$/;
const LEGACY_SIZE_SUFFIXES = new Set([
  'A', 'Ti', 'Th', 'S', 'M', 'L', 'XL', 'X2', 'X3', 'X4', 'X5', 'O',
]);

export type ParsedPath = {
  albumPath: string;
  key: string | null;
};

export function parsePathname(pathname: string): ParsedPath {
  const trimmed = pathname.replace(/\/+$/, '');
  const segments = trimmed.split('/').filter(Boolean);

  while (segments.length > 0 && LEGACY_SIZE_SUFFIXES.has(segments[segments.length - 1])) {
    segments.pop();
  }

  let key: string | null = null;
  if (segments.length > 0) {
    const match = segments[segments.length - 1].match(IMAGE_KEY_RE);
    if (match) {
      key = match[1];
      segments.pop();
    }
  }

  const albumPath = segments.length === 0 ? '/' : '/' + segments.join('/');
  return { albumPath, key };
}

export function buildImagePath(albumPath: string, imageId: string): string {
  const trimmed = albumPath.replace(/\/+$/, '');
  return `${trimmed}/i-${imageId}`;
}

export function isNativeImageId(value: string): boolean {
  return NATIVE_IMAGE_ID_RE.test(value);
}
