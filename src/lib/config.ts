import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');

export type ResolvedConfig = {
  contentRoot: string;
  contentDir: string;
  buildDir: string;
};

let cache: ResolvedConfig | null = null;

export function loadConfig(): ResolvedConfig {
  if (cache) return cache;
  const text = readFileSync(resolve(REPO_ROOT, '.config.yaml'), 'utf8');
  const cfg = yaml.load(text) as { content_root?: string } | null;
  if (!cfg?.content_root) {
    throw new Error('.config.yaml missing content_root');
  }
  const contentRoot = resolve(cfg.content_root);
  cache = {
    contentRoot,
    contentDir: resolve(contentRoot, 'content'),
    buildDir: resolve(contentRoot, 'build'),
  };
  return cache;
}
