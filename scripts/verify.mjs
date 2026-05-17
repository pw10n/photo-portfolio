#!/usr/bin/env node
// Build invariants per TDD §14. Runs after `astro build`.
// Each check returns { name, failures: string[] }. Exits non-zero if any failure.

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import yaml from 'js-yaml';
import sharp from 'sharp';
import { loadConfig } from './_config.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DIST = resolve(REPO_ROOT, 'dist');
const ALBUMS_DIR = resolve(REPO_ROOT, 'src', 'content', 'albums');
const FOLDERS_DIR = resolve(REPO_ROOT, 'src', 'content', 'folders');

const IMAGE_ID_RE = /^[a-z2-7]{11}$/;
const ALBUM_ID_RE = /^alb_[A-Za-z0-9]+$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const SAMPLE_DERIV_COUNT = 20;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function readDirSafe(p) {
  try {
    return await readdir(p);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function loadAlbums() {
  const files = (await readDirSafe(ALBUMS_DIR)).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(resolve(ALBUMS_DIR, f), 'utf8'))));
}

async function loadFolders() {
  const files = (await readDirSafe(FOLDERS_DIR)).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(resolve(FOLDERS_DIR, f), 'utf8'))));
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Checks
// ────────────────────────────────────────────────────────────────────────────

async function checkAlbumCoverage(albums) {
  const failures = [];
  for (const a of albums) {
    const htmlPath = resolve(DIST, a.url_path.replace(/^\//, ''), 'index.html');
    if (!(await pathExists(htmlPath))) {
      failures.push(`missing HTML for album ${a.url_path} → ${relative(REPO_ROOT, htmlPath)}`);
    }
  }
  return { name: 'album HTML coverage', failures };
}

async function checkFolderCoverage(folders) {
  const failures = [];
  for (const f of folders) {
    const htmlPath = resolve(DIST, f.url_path.replace(/^\//, ''), 'index.html');
    if (!(await pathExists(htmlPath))) {
      failures.push(`missing HTML for folder ${f.url_path} → ${relative(REPO_ROOT, htmlPath)}`);
    }
  }
  return { name: 'folder HTML coverage', failures };
}

async function checkAssetCoverage(albums, imageMeta, derivDir) {
  const failures = [];
  for (const a of albums) {
    for (const img of a.images) {
      const meta = imageMeta[img.image_id];
      if (!meta) {
        failures.push(`image ${img.image_id} (${a.url_path}/${img.filename}) missing from image-meta.json`);
        continue;
      }
      const widths = meta.widths ?? [];
      if (widths.length === 0) {
        failures.push(`image ${img.image_id} has no derivative widths`);
        continue;
      }
      const targetWidth = widths.includes(960) ? 960 : Math.max(...widths);
      const formats = meta.formats ?? [];
      const present = await Promise.all(
        formats.map((fmt) => pathExists(resolve(derivDir, img.image_id, `${targetWidth}.${fmt}`))),
      );
      if (!present.some(Boolean)) {
        failures.push(`image ${img.image_id} has no derivative at width ${targetWidth} in any format`);
      }
    }
  }
  return { name: 'asset coverage', failures };
}

async function checkSitemapPurity() {
  const failures = [];
  const candidates = [];
  for (const name of await readDirSafe(DIST)) {
    if (name.startsWith('sitemap') && name.endsWith('.xml')) candidates.push(resolve(DIST, name));
  }
  candidates.push(resolve(DIST, 'index.html'));
  for (const p of candidates) {
    if (!(await pathExists(p))) continue;
    const text = await readFile(p, 'utf8');
    if (text.includes('/private/') || text.includes('"/private"')) {
      failures.push(`${relative(REPO_ROOT, p)} references /private/`);
    }
  }
  return { name: 'sitemap & feed purity', failures };
}

async function collectPlaintextPasswords(contentDir) {
  const set = new Set();
  for await (const p of walk(contentDir)) {
    if (!p.endsWith('meta.yaml')) continue;
    try {
      const data = yaml.load(await readFile(p, 'utf8')) ?? {};
      if (typeof data.password === 'string' && data.password.trim().length > 0) {
        set.add(data.password);
      }
    } catch {
      // skip unparseable
    }
  }
  return set;
}

async function checkPasswordsAndLeaks(albums, plaintexts) {
  const failures = [];
  for (const a of albums) {
    if (a.security_type !== 'password') continue;
    if (!a.password_hash || !HEX64_RE.test(a.password_hash)) {
      failures.push(`album ${a.url_path}: password_hash missing or not 64-char hex`);
    }
    if (!a.password_salt || a.password_salt.length === 0) {
      failures.push(`album ${a.url_path}: password_salt missing`);
    }
  }

  if (plaintexts.size > 0) {
    const scanRoots = [
      resolve(REPO_ROOT, 'src', 'content'),
      DIST,
    ];
    for (const root of scanRoots) {
      for await (const p of walk(root)) {
        if (!/\.(json|html|js|css|txt|xml)$/.test(p)) continue;
        const text = await readFile(p, 'utf8');
        for (const pw of plaintexts) {
          if (text.includes(pw)) {
            failures.push(`plaintext password leaked into ${relative(REPO_ROOT, p)}`);
          }
        }
      }
    }
  }
  return { name: 'password hashes & no-plaintext-leak', failures };
}

async function checkRedirects() {
  const failures = [];
  const path = resolve(DIST, '_redirects');
  if (!(await pathExists(path))) {
    failures.push(`_redirects not present in dist/`);
    return { name: '_redirects present', failures };
  }
  const text = await readFile(path, 'utf8');
  if (!/\/\*\/i-:key\s+\/:splat\/index\.html\s+200/.test(text)) {
    failures.push('_redirects missing `/*/i-:key /:splat/index.html 200`');
  }
  if (!/\/\*\/i-:key\/\*\s+\/:splat\/index\.html\s+200/.test(text)) {
    failures.push('_redirects missing `/*/i-:key/* /:splat/index.html 200`');
  }
  return { name: '_redirects present', failures };
}

async function checkNoUpscale(imageMeta, derivDir) {
  const failures = [];
  const ids = Object.keys(imageMeta);
  if (ids.length === 0) return { name: 'no upscaled derivatives (sample)', failures };

  const sample = [];
  const usedIds = new Set();
  while (sample.length < SAMPLE_DERIV_COUNT && usedIds.size < ids.length) {
    const id = ids[Math.floor(Math.random() * ids.length)];
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const meta = imageMeta[id];
    if (!meta?.widths?.length) continue;
    const w = meta.widths[Math.floor(Math.random() * meta.widths.length)];
    const fmt = (meta.formats ?? ['jpg'])[0];
    const path = resolve(derivDir, id, `${w}.${fmt}`);
    if (await pathExists(path)) sample.push({ id, w, path, intrinsic: meta.width });
  }

  for (const s of sample) {
    try {
      const m = await sharp(s.path).metadata();
      if (m.width && m.width > s.intrinsic) {
        failures.push(`derivative ${relative(REPO_ROOT, s.path)} is ${m.width}px wide, exceeds intrinsic ${s.intrinsic}`);
      }
    } catch (err) {
      failures.push(`could not read ${relative(REPO_ROOT, s.path)}: ${err.message}`);
    }
  }
  return { name: `no upscaled derivatives (sample ${sample.length})`, failures };
}

async function checkLegacyKeys(albums, legacyKeys) {
  const failures = [];
  const albumByPath = new Map(albums.map((a) => [a.url_path, a]));
  for (const [key, entry] of Object.entries(legacyKeys)) {
    if (!entry?.album || !entry?.file) {
      failures.push(`legacy key ${key} has malformed entry`);
      continue;
    }
    const album = albumByPath.get(entry.album);
    if (!album) {
      failures.push(`legacy key ${key} → album ${entry.album} no longer exists`);
      continue;
    }
    if (!album.images.some((img) => img.filename === entry.file)) {
      failures.push(`legacy key ${key} → ${entry.album}/${entry.file} not found among album images`);
    }
  }
  return { name: 'legacy-keys coverage', failures };
}

async function checkAlbumIds(albums) {
  const failures = [];
  const seen = new Map();
  for (const a of albums) {
    if (!a.id || !ALBUM_ID_RE.test(a.id)) {
      failures.push(`album ${a.url_path}: id "${a.id}" does not match ${ALBUM_ID_RE}`);
      continue;
    }
    if (seen.has(a.id)) {
      failures.push(`duplicate album id ${a.id} on ${a.url_path} and ${seen.get(a.id)}`);
    } else {
      seen.set(a.id, a.url_path);
    }
  }
  return { name: 'album id present & unique', failures };
}

async function checkNamespaceNonOverlap(albums, legacyKeys) {
  const failures = [];
  const imageIds = new Set();
  for (const a of albums) for (const img of a.images) imageIds.add(img.image_id);

  for (const key of Object.keys(legacyKeys)) {
    if (imageIds.has(key)) {
      failures.push(`legacy key ${key} collides with a native image_id`);
    }
    if (IMAGE_ID_RE.test(key)) {
      failures.push(`legacy key ${key} matches native image_id charset+length (^[a-z2-7]{11}$)`);
    }
  }
  return { name: 'native id ⊥ legacy key namespace', failures };
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const { contentDir, buildDir } = await loadConfig();
  const derivDir = resolve(buildDir, 'derivatives');
  const [albums, folders, imageMeta, legacyKeys, plaintexts] = await Promise.all([
    loadAlbums(),
    loadFolders(),
    readJson(resolve(buildDir, 'image-meta.json'), {}),
    readJson(resolve(buildDir, 'legacy-keys.json'), {}),
    collectPlaintextPasswords(contentDir),
  ]);

  const results = await Promise.all([
    checkAlbumCoverage(albums),
    checkFolderCoverage(folders),
    checkAssetCoverage(albums, imageMeta, derivDir),
    checkSitemapPurity(),
    checkPasswordsAndLeaks(albums, plaintexts),
    checkRedirects(),
    checkNoUpscale(imageMeta, derivDir),
    checkLegacyKeys(albums, legacyKeys),
    checkAlbumIds(albums),
    checkNamespaceNonOverlap(albums, legacyKeys),
  ]);

  let failed = 0;
  for (const r of results) {
    if (r.failures.length === 0) {
      console.log(`  ✓ ${r.name}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${r.name} (${r.failures.length})`);
      for (const f of r.failures.slice(0, 10)) console.log(`      - ${f}`);
      if (r.failures.length > 10) console.log(`      … +${r.failures.length - 10} more`);
    }
  }

  if (failed > 0) {
    console.error(`\nverify: ${failed} of ${results.length} checks failed`);
    process.exit(1);
  }
  console.log(`\nverify: ${results.length}/${results.length} checks passed`);
}

main().catch((err) => {
  console.error('verify failed:', err);
  process.exit(1);
});
