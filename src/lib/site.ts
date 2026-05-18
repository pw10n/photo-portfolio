import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { loadConfig } from './config';

export type SiteConfig = {
  site_url: string;
  assets_base_url: string;
  name: string;
  short_name: string;
  tagline: string;
  copyright_holder: string;
  homepage: { hero_title: string; hero_subtitle: string };
};

const REQUIRED = ['site_url', 'name'] as const;

let cache: SiteConfig | null = null;

export function loadSite(): SiteConfig {
  if (cache) return cache;
  const { contentRoot } = loadConfig();
  const path = resolve(contentRoot, 'site.yaml');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new Error(
        `Missing ${path}. Create it from .site.example.yaml in this repo ` +
        `and fill in site_url, assets_base_url, and name.`,
      );
    }
    throw err;
  }
  const raw = (yaml.load(text) ?? {}) as Record<string, unknown>;
  for (const k of REQUIRED) {
    if (typeof raw[k] !== 'string' || !raw[k]) {
      throw new Error(`${path}: \`${k}\` is required (string)`);
    }
  }
  const homepage = (raw.homepage as Record<string, string> | undefined) ?? {};
  cache = {
    site_url: (raw.site_url as string).replace(/\/+$/, ''),
    assets_base_url: ((raw.assets_base_url as string) ?? '').replace(/\/+$/, ''),
    name: raw.name as string,
    short_name: (raw.short_name as string) ?? (raw.name as string),
    tagline: (raw.tagline as string) ?? '',
    copyright_holder: (raw.copyright_holder as string) ?? '',
    homepage: {
      hero_title: homepage.hero_title ?? '',
      hero_subtitle: homepage.hero_subtitle ?? '',
    },
  };
  return cache;
}
