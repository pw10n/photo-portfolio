#!/usr/bin/env node
// One-time migration: walk the SmugMug manifest and seed the local content
// repo with per-folder and per-album meta.yaml + a .legacy-keys.json index
// that preserves SmugMug image_key → {album, file} for URL continuity.
//
// Idempotent: refuses to overwrite existing meta.yaml files unless --force.
// Reads content_root from .config.yaml.
//
// Usage:
//   node scripts/manifest_to_yaml.mjs
//   node scripts/manifest_to_yaml.mjs --manifest scripts/manifest.json
//   node scripts/manifest_to_yaml.mjs --force
//   node scripts/manifest_to_yaml.mjs --dry-run

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { loadConfig } from './_config.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

// ────────────────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    force: false,
    dryRun: false,
    manifest: resolve(REPO_ROOT, 'scripts', 'manifest.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--manifest') opts.manifest = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: manifest_to_yaml.mjs [--manifest <path>] [--force] [--dry-run]');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// ────────────────────────────────────────────────────────────────────────────
// Filename sanitization — mirrors scripts/smugmug_download.py so that the
// legacy-keys map records the actual on-disk filename, not the raw manifest
// value. Without this, any image whose original filename contains "/" or "\"
// would be unfindable when yaml_to_content.mjs walks the directory.
// ────────────────────────────────────────────────────────────────────────────

function sanitize(segment) {
  const cleaned = (segment ?? '').replace(/[\/\\\0]/g, '_').trim();
  return cleaned || '_';
}

function disambiguate(filename, imageKey) {
  const dot = filename.lastIndexOf('.');
  if (dot > 0) {
    return `${filename.slice(0, dot)}__${imageKey}${filename.slice(dot)}`;
  }
  return `${filename}__${imageKey}`;
}

function urlPathSegments(urlPath) {
  return (urlPath ?? '').replace(/^\/+/, '').split('/').filter(Boolean).map(sanitize);
}

// ────────────────────────────────────────────────────────────────────────────
// Field mapping from manifest → meta.yaml shape
// ────────────────────────────────────────────────────────────────────────────

function mapPrivacy(p) {
  const v = String(p ?? 'Public').toLowerCase();
  return v === 'unlisted' ? 'unlisted' : 'public';
}

function mapSecurityType(s) {
  const v = String(s ?? 'None').toLowerCase();
  return v === 'password' ? 'password' : 'none';
}

function mapSort(method) {
  const v = String(method ?? '').toLowerCase();
  if (v.includes('filename') || v.includes('name')) return 'filename';
  if (v.includes('manual') || v.includes('custom') || v.includes('position')) return 'manual';
  return 'date';
}

function isoDateOnly(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return null;
  return d.toISOString().slice(0, 10);
}

function dquote(s) {
  return JSON.stringify(String(s ?? ''));
}

// ────────────────────────────────────────────────────────────────────────────
// YAML rendering — hand-rolled so the field order matches the README and
// the resulting file is friendly to hand-editing afterward.
// ────────────────────────────────────────────────────────────────────────────

function renderFolderYaml(folder) {
  const lines = [
    `name: ${dquote(folder.name)}`,
    `url_name: ${folder.url_name}`,
    `description: ${dquote(folder.description || '')}`,
    `privacy: ${mapPrivacy(folder.privacy)}`,
    `source:`,
    `  smugmug:`,
    `    node_id: ${folder.node_id}`,
    `    url_path: ${folder.url_path}`,
    ``,
  ];
  return lines.join('\n');
}

function renderAlbumYaml(album) {
  const id = `alb_${album.album_key}`;
  const lines = [
    `id: ${id}`,
    `name: ${dquote(album.name)}`,
    `url_name: ${album.url_name}`,
  ];
  const date = isoDateOnly(album.date_added);
  if (date) lines.push(`date: ${date}`);
  lines.push(`description: ${dquote(album.description || '')}`);
  if (Array.isArray(album.keywords) && album.keywords.length > 0) {
    lines.push(`keywords: [${album.keywords.map(dquote).join(', ')}]`);
  } else {
    lines.push(`keywords: []`);
  }
  lines.push(`privacy: ${mapPrivacy(album.privacy)}`);
  const securityType = mapSecurityType(album.security_type);
  lines.push(`security_type: ${securityType}`);
  if (securityType === 'password') {
    lines.push(`password: ${dquote(album.password ?? '')}`);
    if (album.password_hint) lines.push(`password_hint: ${dquote(album.password_hint)}`);
    else lines.push(`password_hint: null`);
  } else {
    lines.push(`password: null`);
    lines.push(`password_hint: null`);
  }
  lines.push(`sort: ${mapSort(album.sort_method)}`);
  lines.push(`hero: null`);

  // Sparse per-image overrides: emit only when caption or keywords non-empty.
  const overrides = [];
  for (const img of album.images || []) {
    const onDisk = album.__onDiskByKey?.[img.image_key];
    if (!onDisk) continue;
    const caption = (img.caption || '').trim();
    const keywords = Array.isArray(img.keywords) ? img.keywords.filter(Boolean) : [];
    if (!caption && keywords.length === 0) continue;
    overrides.push({ filename: onDisk, caption, keywords });
  }
  if (overrides.length === 0) {
    lines.push(`images: {}`);
  } else {
    lines.push(`images:`);
    for (const o of overrides) {
      lines.push(`  ${quoteKey(o.filename)}:`);
      if (o.caption) lines.push(`    caption: ${dquote(o.caption)}`);
      if (o.keywords.length > 0) lines.push(`    keywords: [${o.keywords.map(dquote).join(', ')}]`);
    }
  }

  lines.push(`source:`);
  lines.push(`  smugmug:`);
  lines.push(`    node_id: ${album.node_id}`);
  lines.push(`    album_key: ${album.album_key}`);
  lines.push(`    url_path: ${album.url_path}`);
  lines.push(``);
  return lines.join('\n');
}

function quoteKey(name) {
  if (/^[A-Za-z0-9_.\-]+$/.test(name)) return name;
  return dquote(name);
}

// ────────────────────────────────────────────────────────────────────────────
// File system helpers
// ────────────────────────────────────────────────────────────────────────────

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path, contents, { dryRun }) {
  if (dryRun) return;
  const tmp = path + '.tmp';
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // requireContentDir=false: a fresh migration is the moment when content/
  // doesn't exist yet — we'll create it as we write meta.yaml files.
  const { contentRoot, contentDir } = await loadConfig({ requireContentDir: false });
  if (!opts.dryRun) await mkdir(contentDir, { recursive: true });

  const manifestText = await readFile(opts.manifest, 'utf8');
  const manifest = JSON.parse(manifestText);

  const nodes = Array.isArray(manifest.nodes) ? manifest.nodes : [];
  const folders = nodes.filter((n) => n?.type === 'folder');
  const albums = nodes.filter((n) => n?.type === 'album');

  console.log(`manifest_to_yaml`);
  console.log(`  content_root:  ${contentRoot}`);
  console.log(`  content_dir:   ${contentDir}`);
  console.log(`  manifest:      ${opts.manifest}`);
  console.log(`  folders:       ${folders.length}`);
  console.log(`  albums:        ${albums.length}`);
  console.log(`  images:        ${albums.reduce((n, a) => n + (a.images?.length ?? 0), 0)}`);
  console.log(`  mode:          ${opts.dryRun ? 'dry-run' : 'write'}${opts.force ? ' (--force)' : ''}`);
  console.log('');

  let foldersWritten = 0;
  let foldersSkipped = 0;
  let albumsWritten = 0;
  let albumsSkipped = 0;
  let missingFiles = 0;
  let totalImageEntries = 0;
  const legacyKeys = {};
  const missingSamples = [];
  const MAX_MISSING_SAMPLES = 10;

  // Folders first
  for (const f of folders) {
    if (!f.url_path) continue;
    const segments = urlPathSegments(f.url_path);
    if (segments.length === 0) continue;
    const dir = resolve(contentDir, ...segments);
    const metaPath = resolve(dir, 'meta.yaml');
    if (await exists(metaPath) && !opts.force) {
      foldersSkipped += 1;
      continue;
    }
    if (!opts.dryRun) await mkdir(dir, { recursive: true });
    await writeAtomic(metaPath, renderFolderYaml(f), opts);
    foldersWritten += 1;
  }

  // Albums: compute on-disk filenames (sanitize + disambiguate), build legacy
  // map, then write album meta.yaml + verify originals exist.
  for (const a of albums) {
    if (!a.url_path) continue;
    const segments = urlPathSegments(a.url_path);
    if (segments.length === 0) continue;
    const dir = resolve(contentDir, ...segments);
    const metaPath = resolve(dir, 'meta.yaml');

    const onDiskByKey = {};
    const used = new Map();
    for (const img of a.images || []) {
      if (!img?.image_key || !img?.filename) continue;
      const base = sanitize(img.filename) || `${img.image_key}.jpg`;
      const caseKey = base.toLowerCase();
      const count = used.get(caseKey) ?? 0;
      used.set(caseKey, count + 1);
      const onDisk = count === 0 ? base : disambiguate(base, img.image_key);
      onDiskByKey[img.image_key] = onDisk;

      legacyKeys[img.image_key] = {
        album: a.url_path,
        file: onDisk,
      };
      totalImageEntries += 1;

      const expectedPath = resolve(dir, onDisk);
      if (!(await exists(expectedPath))) {
        missingFiles += 1;
        if (missingSamples.length < MAX_MISSING_SAMPLES) {
          missingSamples.push(`${a.url_path}/${onDisk}`);
        }
      }
    }

    if (await exists(metaPath) && !opts.force) {
      albumsSkipped += 1;
    } else {
      if (!opts.dryRun) await mkdir(dir, { recursive: true });
      await writeAtomic(metaPath, renderAlbumYaml({ ...a, __onDiskByKey: onDiskByKey }), opts);
      albumsWritten += 1;
    }
  }

  const legacyPath = resolve(contentDir, '.legacy-keys.json');
  await writeAtomic(legacyPath, JSON.stringify(legacyKeys, null, 2), opts);

  console.log(`Folders:  wrote ${foldersWritten}, skipped ${foldersSkipped} (existing meta.yaml)`);
  console.log(`Albums:   wrote ${albumsWritten}, skipped ${albumsSkipped} (existing meta.yaml)`);
  console.log(`Legacy keys: ${totalImageEntries} entries → ${opts.dryRun ? '(would write) ' : ''}${legacyPath}`);
  if (missingFiles > 0) {
    console.log(`Missing originals: ${missingFiles} (image referenced in manifest but file not on disk)`);
    console.log(`  sample paths (first ${missingSamples.length}):`);
    for (const p of missingSamples) console.log(`    ${p}`);
    if (missingFiles > missingSamples.length) {
      console.log(`    … and ${missingFiles - missingSamples.length} more`);
    }
  } else {
    console.log(`Missing originals: 0`);
  }
  if (foldersSkipped + albumsSkipped > 0 && !opts.force) {
    console.log(`\nTip: rerun with --force to overwrite existing meta.yaml files.`);
  }
}

main().catch((err) => {
  console.error('manifest_to_yaml failed:', err.message);
  process.exit(1);
});
