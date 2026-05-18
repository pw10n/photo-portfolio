// Loads <content_root>/site.yaml. The site config lives outside the repo so
// this tooling is reusable across multiple sites.
//
// Profile support: if PROFILE env var is set, also load
// <content_root>/site.<profile>.yaml and shallow-merge it over the base.
// Special-case: PROFILE=local has built-in defaults so a site.local.yaml
// is optional. .env can still override individual env vars.
//
// Used by:
//   - astro.config.mjs (for `site:` → sitemap + OG canonical)
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

// Built-in defaults for known profiles so users don't need to write a
// site.<profile>.yaml unless they want to override something.
const PROFILE_DEFAULTS = {
  local: {
    site_url: 'http://localhost:4321',
    assets_base_url: '',
  },
};

function mergeProfile(base, override) {
  if (!override) return base;
  return {
    ...base,
    ...override,
    homepage: { ...(base.homepage ?? {}), ...(override.homepage ?? {}) },
  };
}

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
  let raw = yaml.load(text) ?? {};

  const profile = process.env.PROFILE;
  if (profile) {
    const profilePath = resolve(contentRoot, `site.${profile}.yaml`);
    let profileRaw = null;
    try {
      profileRaw = yaml.load(readFileSync(profilePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!profileRaw && !PROFILE_DEFAULTS[profile]) {
      throw new Error(`PROFILE=${profile} but ${profilePath} not found, and no built-in defaults for that profile name.`);
    }
    raw = mergeProfile(raw, PROFILE_DEFAULTS[profile] ?? null);
    raw = mergeProfile(raw, profileRaw ?? null);
  }

  return normalize(raw, sitePath);
}
