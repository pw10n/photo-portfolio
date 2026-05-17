// Shared .config.yaml loader for all scripts.
//
// Layout under content_root:
//   <content_root>/
//   ├── content/        # photos + per-album meta.yaml + .legacy-keys.json
//   └── build/          # derivatives, image-meta.json, derivative-cache.json,
//                         legacy-keys.json (mirrored from content/.legacy-keys.json)

import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');

export async function loadConfig({ requireContentDir = true, ensureBuildDir = false } = {}) {
  const cfgPath = resolve(REPO_ROOT, '.config.yaml');
  let text;
  try {
    text = await readFile(cfgPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`.config.yaml not found at ${cfgPath}. Copy .config.example.yaml and set content_root.`);
    }
    throw err;
  }
  const cfg = yaml.load(text) ?? {};
  if (!cfg.content_root || typeof cfg.content_root !== 'string') {
    throw new Error('.config.yaml missing required `content_root`');
  }
  const contentRoot = resolve(cfg.content_root);
  const rootStat = await stat(contentRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`content_root does not exist or is not a directory: ${contentRoot}`);
  }

  const contentDir = resolve(contentRoot, 'content');
  const buildDir = resolve(contentRoot, 'build');

  if (requireContentDir) {
    const cs = await stat(contentDir).catch(() => null);
    if (!cs?.isDirectory()) {
      throw new Error(
        `Expected ${contentDir} to exist.\n` +
        `Photos and meta.yaml live under <content_root>/content/. ` +
        `If you previously had files directly under <content_root>/, move them into <content_root>/content/.`,
      );
    }
  }

  if (ensureBuildDir) {
    await mkdir(buildDir, { recursive: true });
  }

  return { contentRoot, contentDir, buildDir, repoRoot: REPO_ROOT };
}
