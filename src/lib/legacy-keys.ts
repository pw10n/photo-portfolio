import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type LegacyKeyEntry = { album: string; file: string };
export type LegacyKeys = Record<string, LegacyKeyEntry>;

const here = dirname(fileURLToPath(import.meta.url));
const LEGACY_KEYS_PATH = resolve(here, '../../build/legacy-keys.json');

let cache: LegacyKeys | null = null;

export async function loadLegacyKeys(): Promise<LegacyKeys> {
  if (cache) return cache;
  try {
    const buf = await readFile(LEGACY_KEYS_PATH, 'utf8');
    cache = JSON.parse(buf) as LegacyKeys;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') {
      cache = {};
    } else {
      throw err;
    }
  }
  return cache;
}

export async function legacyKeysForAlbum(
  albumPath: string,
): Promise<Record<string, string>> {
  const all = await loadLegacyKeys();
  const slice: Record<string, string> = {};
  for (const [key, entry] of Object.entries(all)) {
    if (entry.album === albumPath) slice[key] = entry.file;
  }
  return slice;
}
