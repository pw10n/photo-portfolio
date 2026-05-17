import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config';

export type LegacyKeyEntry = { album: string; file: string };
export type LegacyKeys = Record<string, LegacyKeyEntry>;

let cache: LegacyKeys | null = null;

export async function loadLegacyKeys(): Promise<LegacyKeys> {
  if (cache) return cache;
  const { buildDir } = loadConfig();
  const path = resolve(buildDir, 'legacy-keys.json');
  try {
    const buf = await readFile(path, 'utf8');
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

export async function legacyKeysForAlbum(albumPath: string): Promise<Record<string, string>> {
  const all = await loadLegacyKeys();
  const slice: Record<string, string> = {};
  for (const [key, entry] of Object.entries(all)) {
    if (entry.album === albumPath) slice[key] = entry.file;
  }
  return slice;
}
