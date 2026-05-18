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

// Built-in defaults for known profile names. site.<profile>.yaml in
// content_root is optional and shallow-merges on top of these.
const PROFILE_DEFAULTS: Record<string, Partial<SiteConfig>> = {
  local: {
    site_url: 'http://localhost:4321',
    assets_base_url: '',
  },
};

let cache: SiteConfig | null = null;

function tryReadYaml(path: string): Record<string, unknown> | null {
  try {
    return (yaml.load(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

function mergeProfile(base: Record<string, unknown>, override: Record<string, unknown> | Partial<SiteConfig> | null): Record<string, unknown> {
  if (!override) return base;
  const baseHome = (base.homepage as Record<string, unknown>) ?? {};
  const overHome = (override as Record<string, unknown>).homepage as Record<string, unknown> | undefined;
  return {
    ...base,
    ...(override as Record<string, unknown>),
    homepage: { ...baseHome, ...(overHome ?? {}) },
  };
}

export function loadSite(): SiteConfig {
  if (cache) return cache;
  const { contentRoot } = loadConfig();
  const sitePath = resolve(contentRoot, 'site.yaml');
  const baseRaw = tryReadYaml(sitePath);
  if (!baseRaw) {
    throw new Error(
      `Missing ${sitePath}. Create it from .site.example.yaml in this repo ` +
      `and fill in site_url and name (assets_base_url too once you have R2 set up).`,
    );
  }

  const profile = (typeof process !== 'undefined' && process.env?.PROFILE) || undefined;
  let raw: Record<string, unknown> = baseRaw;
  if (profile) {
    const profilePath = resolve(contentRoot, `site.${profile}.yaml`);
    const profileRaw = tryReadYaml(profilePath);
    if (!profileRaw && !PROFILE_DEFAULTS[profile]) {
      throw new Error(`PROFILE=${profile} but ${profilePath} not found, and no built-in defaults for that profile.`);
    }
    raw = mergeProfile(raw, PROFILE_DEFAULTS[profile] ?? null);
    raw = mergeProfile(raw, profileRaw ?? null);
  }

  for (const k of REQUIRED) {
    if (typeof raw[k] !== 'string' || !raw[k]) {
      throw new Error(`${sitePath}: \`${k}\` is required (string)`);
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
