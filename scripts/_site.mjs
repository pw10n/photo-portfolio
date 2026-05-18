// Loads <content_root>/site.yaml. The site config lives outside the repo so
// this tooling is reusable across multiple sites.
//
// Used by:
//   - astro.config.mjs (for `site:` → sitemap + OG canonical)
//   - src/lib/asset-urls.ts (for the default R2 base URL)
//   - BaseLayout.astro, HomePage.astro (for display strings)
//
// .site.example.yaml at the repo root documents the schema.

import { readFile, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { loadConfig } from './_config.mjs';

const DEFAULTS = {
  short_name: null,
  tagline: '',
  copyright_holder: '',
  homepage: { hero_title: '', hero_subtitle: '' },
};

const REQUIRED = ['site_url', 'name'];

function normalize(raw, path) {
  for (const k of REQUIRED) {
    if (!raw?.[k] || typeof raw[k] !== 'string') {
      throw new Error(`${path}: \`${k}\` is required (string)`);
    }
  }
  return {
    site_url: raw.site_url.replace(/\/+$/, ''),
    assets_base_url: (raw.assets_base_url ?? '').replace(/\/+$/, ''),
    name: raw.name,
    short_name: raw.short_name ?? raw.name,
    tagline: raw.tagline ?? DEFAULTS.tagline,
    copyright_holder: raw.copyright_holder ?? DEFAULTS.copyright_holder,
    homepage: {
      hero_title: raw.homepage?.hero_title ?? DEFAULTS.homepage.hero_title,
      hero_subtitle: raw.homepage?.hero_subtitle ?? DEFAULTS.homepage.hero_subtitle,
    },
  };
}

export async function loadSite() {
  const { contentRoot } = await loadConfig({ requireContentDir: false });
  const path = resolve(contentRoot, 'site.yaml');
  let text;
  try {
    text = await new Promise((res, rej) => {
      readFile(path, 'utf8', (err, data) => (err ? rej(err) : res(data)));
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Missing ${path}.\n` +
        `Create it from .site.example.yaml in this repo and fill in site_url, ` +
        `assets_base_url, and name.`,
      );
    }
    throw err;
  }
  return normalize(yaml.load(text) ?? {}, path);
}

// Synchronous variant for callers that can't await (e.g. astro.config.mjs).
export function loadSiteSync() {
  const cfgPath = resolve(import.meta.dirname, '..', '.config.yaml');
  let cfgText;
  try {
    cfgText = readFileSync(cfgPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`.config.yaml not found at ${cfgPath}`);
    }
    throw err;
  }
  const cfg = yaml.load(cfgText);
  if (!cfg?.content_root) throw new Error('.config.yaml missing content_root');
  const contentRoot = resolve(cfg.content_root);
  const sitePath = resolve(contentRoot, 'site.yaml');
  let text;
  try {
    text = readFileSync(sitePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Missing ${sitePath}.\n` +
        `Create it from .site.example.yaml in this repo and fill in site_url, ` +
        `assets_base_url, and name.`,
      );
    }
    throw err;
  }
  return normalize(yaml.load(text) ?? {}, sitePath);
}
