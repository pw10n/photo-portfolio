#!/usr/bin/env node
// Walk <content_root>/, classify folder vs album, emit
// src/content/{albums,folders}/<slug>.json for Astro Content Collections.
// Also stamps album.id back into meta.yaml when missing, hashes passwords,
// and mirrors <content_root>/.legacy-keys.json into build/legacy-keys.json.

import { mkdir, readFile, readdir, rm, writeFile, copyFile, rename } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
import exifr from 'exifr';
import { loadConfig } from './_config.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SRC_CONTENT = resolve(REPO_ROOT, 'src', 'content');

const IMAGE_EXT_RE = /\.(jpe?g|png)$/i;
const ALBUM_FIELDS = new Set(['date', 'security_type', 'sort', 'images', 'hero', 'password', 'password_hint']);

function base32Encode(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}

function imageIdFor(albumId, filename) {
  const digest = createHash('sha256').update(`${albumId}/${filename}`).digest();
  return base32Encode(digest).slice(0, 11);
}

function newAlbumId() {
  return 'alb_' + base32Encode(randomBytes(5)).slice(0, 8);
}

function newSaltB64() {
  return randomBytes(16).toString('base64');
}

function sha256Hex(bufs) {
  const h = createHash('sha256');
  for (const b of bufs) h.update(b);
  return h.digest('hex');
}

async function* walkDirs(root) {
  const entries = await readdir(root, { withFileTypes: true });
  yield { dir: root, entries };
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')) {
      yield* walkDirs(resolve(root, e.name));
    }
  }
}

function urlPathFor(contentDir, dir) {
  const rel = relative(contentDir, dir);
  if (rel === '') return '/';
  return '/' + rel.split(sep).join('/');
}

async function readMetaYaml(dir) {
  const path = resolve(dir, 'meta.yaml');
  try {
    const text = await readFile(path, 'utf8');
    return { path, text, data: yaml.load(text) ?? {} };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function classify(meta, entries) {
  const hasImages = entries.some((e) => e.isFile() && IMAGE_EXT_RE.test(e.name));
  const hasAlbumField = meta && Object.keys(meta.data).some((k) => ALBUM_FIELDS.has(k));
  if (hasImages || hasAlbumField) return 'album';
  return 'folder';
}

async function stampAlbumId(meta) {
  if (meta.data.id) return meta.data.id;
  const id = newAlbumId();
  const newText = `id: ${id}\n${meta.text}`;
  const tmp = meta.path + '.tmp';
  await writeFile(tmp, newText);
  await rename(tmp, meta.path);
  meta.data.id = id;
  meta.text = newText;
  return id;
}

async function resolveImageCaptionKeywords(imgPath, override) {
  if (override) {
    return {
      caption: typeof override.caption === 'string' ? override.caption : '',
      keywords: Array.isArray(override.keywords) ? override.keywords : [],
    };
  }
  try {
    const parsed = await exifr.parse(imgPath, {
      iptc: true,
      xmp: true,
      tiff: false,
      exif: false,
      gps: false,
      jfif: false,
      ihdr: false,
    });
    const caption =
      (parsed?.Caption || parsed?.CaptionAbstract || parsed?.['Caption-Abstract'] || parsed?.description || '') + '';
    let keywords = [];
    const rawKw = parsed?.Keywords ?? parsed?.subject ?? parsed?.['dc:subject'];
    if (Array.isArray(rawKw)) keywords = rawKw.map(String);
    else if (typeof rawKw === 'string') keywords = rawKw.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    return {
      caption: caption.trim(),
      keywords: keywords.map((k) => k.trim()).filter(Boolean),
    };
  } catch {
    return { caption: '', keywords: [] };
  }
}

async function loadExistingSalt(slugPath) {
  try {
    const buf = await readFile(slugPath, 'utf8');
    const json = JSON.parse(buf);
    return json.password_salt ?? null;
  } catch {
    return null;
  }
}

async function buildAlbumJson({ dir, meta, urlPath, parentPath, albumsOutDir }) {
  const id = await stampAlbumId(meta);
  const data = meta.data;

  const entries = await readdir(dir, { withFileTypes: true });
  const imageFiles = entries
    .filter((e) => e.isFile() && IMAGE_EXT_RE.test(e.name))
    .map((e) => e.name);

  const sortMode = data.sort || 'filename';
  const overrides = (data.images && typeof data.images === 'object') ? data.images : {};
  const orderedFilenames = applySort(imageFiles, sortMode, overrides);

  // Resolve per-image caption/keywords in parallel — each call reads a small
  // window of the JPEG header for IPTC/XMP, and NFS round-trip dominates
  // when sources live on a network share. Cap concurrency to be polite.
  const PER_ALBUM_CONCURRENCY = 16;
  const images = new Array(orderedFilenames.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= orderedFilenames.length) return;
      const filename = orderedFilenames[i];
      const override = overrides[filename];
      const { caption, keywords } = await resolveImageCaptionKeywords(resolve(dir, filename), override);
      images[i] = {
        image_id: imageIdFor(id, filename),
        filename,
        caption,
        keywords,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(PER_ALBUM_CONCURRENCY, orderedFilenames.length) }, worker));

  let passwordHash = null;
  let passwordSalt = null;
  const securityType = data.security_type === 'password' ? 'password' : 'none';
  if (securityType === 'password') {
    if (!data.password || typeof data.password !== 'string') {
      throw new Error(`Album ${urlPath} has security_type=password but no plaintext password in meta.yaml`);
    }
    const slugCandidate = resolve(albumsOutDir, `${data.url_name || baseName(urlPath)}.json`);
    const existingSalt = await loadExistingSalt(slugCandidate);
    passwordSalt = existingSalt || newSaltB64();
    passwordHash = sha256Hex([
      Buffer.from(data.password, 'utf8'),
      Buffer.from(passwordSalt, 'base64'),
    ]);
  }

  return {
    id,
    url_path: urlPath,
    url_name: data.url_name || baseName(urlPath),
    name: data.name || baseName(urlPath),
    description: data.description || '',
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
    date: formatDate(data.date),
    privacy: data.privacy === 'unlisted' ? 'unlisted' : 'public',
    security_type: securityType,
    password_hash: passwordHash,
    password_salt: passwordSalt,
    password_hint: data.password_hint || null,
    sort: ['filename', 'date', 'manual'].includes(data.sort) ? data.sort : 'filename',
    hero: data.hero || null,
    parent_path: parentPath,
    images,
  };
}

function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

function baseName(urlPath) {
  if (!urlPath || urlPath === '/') return '';
  return urlPath.split('/').filter(Boolean).pop() || '';
}

function applySort(filenames, mode, overrides) {
  const sorted = [...filenames].sort((a, b) => a.localeCompare(b));
  if (mode === 'manual' && overrides) {
    const explicit = Object.keys(overrides);
    const rest = sorted.filter((f) => !explicit.includes(f));
    return [...explicit.filter((f) => sorted.includes(f)), ...rest];
  }
  return sorted;
}

function slugFor(urlName, urlPath, taken) {
  let slug = urlName;
  if (!taken.has(slug)) {
    taken.set(slug, urlPath);
    return slug;
  }
  if (taken.get(slug) === urlPath) return slug;
  const hash = createHash('sha1').update(urlPath).digest('base64url').slice(0, 6);
  slug = `${urlName}__${hash}`;
  taken.set(slug, urlPath);
  return slug;
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function mirrorLegacyKeys(contentDir, buildDir) {
  const src = resolve(contentDir, '.legacy-keys.json');
  const dst = resolve(buildDir, 'legacy-keys.json');
  await ensureDir(buildDir);
  try {
    await copyFile(src, dst);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      await writeFile(dst, '{}');
      return false;
    }
    throw err;
  }
}

async function clearDir(p) {
  await rm(p, { recursive: true, force: true });
  await ensureDir(p);
}

async function main() {
  const { contentDir, buildDir } = await loadConfig({ ensureBuildDir: true });

  const albumsOutDir = resolve(SRC_CONTENT, 'albums');
  const foldersOutDir = resolve(SRC_CONTENT, 'folders');
  await clearDir(albumsOutDir);
  await clearDir(foldersOutDir);

  const dirRecords = [];
  for await (const { dir, entries } of walkDirs(contentDir)) {
    if (dir === contentDir) continue;
    const meta = await readMetaYaml(dir);
    if (!meta) continue;
    const urlPath = urlPathFor(contentDir, dir);
    const parentDir = dirname(dir);
    const parentPath = parentDir === contentDir ? null : urlPathFor(contentDir, parentDir);
    const kind = classify(meta, entries);
    dirRecords.push({ dir, entries, meta, urlPath, parentPath, kind });
  }

  dirRecords.sort((a, b) => a.urlPath.length - b.urlPath.length);

  const childrenByParent = new Map();
  for (const r of dirRecords) {
    const key = r.parentPath ?? '__root__';
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(r.urlPath);
  }

  const albumSlugs = new Map();
  const folderSlugs = new Map();
  let albumCount = 0;
  let folderCount = 0;

  const totalAlbums = dirRecords.filter((r) => r.kind === 'album').length;
  let imageCountTotal = 0;

  for (const r of dirRecords) {
    if (r.kind === 'album') {
      const json = await buildAlbumJson({
        dir: r.dir,
        meta: r.meta,
        urlPath: r.urlPath,
        parentPath: r.parentPath ?? '/',
        albumsOutDir,
      });
      const urlName = json.url_name || baseName(r.urlPath);
      const slug = slugFor(urlName, r.urlPath, albumSlugs);
      await writeFile(resolve(albumsOutDir, `${slug}.json`), JSON.stringify(json, null, 2));
      albumCount += 1;
      imageCountTotal += json.images.length;
      if (albumCount % 10 === 0 || albumCount === totalAlbums) {
        process.stdout.write(`\r  albums ${albumCount}/${totalAlbums} (${imageCountTotal} images so far)`);
      }
    } else {
      const data = r.meta.data;
      const json = {
        url_path: r.urlPath,
        url_name: data.url_name || baseName(r.urlPath),
        name: data.name || baseName(r.urlPath),
        description: data.description || '',
        privacy: data.privacy === 'unlisted' ? 'unlisted' : 'public',
        parent_path: r.parentPath,
        child_paths: childrenByParent.get(r.urlPath) || [],
      };
      const urlName = json.url_name || baseName(r.urlPath);
      const slug = slugFor(urlName, r.urlPath, folderSlugs);
      await writeFile(resolve(foldersOutDir, `${slug}.json`), JSON.stringify(json, null, 2));
      folderCount += 1;
    }
  }

  if (totalAlbums > 0) process.stdout.write('\n');
  const hasLegacy = await mirrorLegacyKeys(contentDir, buildDir);

  console.log(`yaml_to_content: ${folderCount} folders, ${albumCount} albums, ${imageCountTotal} images`);
  console.log(`  legacy-keys: ${hasLegacy ? 'mirrored' : 'absent (wrote empty stub)'}`);
}

main().catch((err) => {
  console.error('yaml_to_content failed:', err.message);
  process.exit(1);
});
