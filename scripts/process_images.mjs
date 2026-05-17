#!/usr/bin/env node
// Encode AVIF/WebP/JPEG derivatives at multiple widths for every image in
// src/content/albums/*.json. Skip unchanged sources via a hash cache.
// Outputs:
//   build/derivatives/<image_id>/{480,960,1600,2400}.{avif,webp,jpg}
//   build/derivatives/<image_id>/thumb.{avif,webp,jpg}
//   build/image-meta.json
//   build/derivative-cache.json

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import exifr from 'exifr';
import yaml from 'js-yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BUILD_DIR = resolve(REPO_ROOT, 'build');
const DERIV_DIR = resolve(BUILD_DIR, 'derivatives');
const META_PATH = resolve(BUILD_DIR, 'image-meta.json');
const CACHE_PATH = resolve(BUILD_DIR, 'derivative-cache.json');
const ALBUMS_DIR = resolve(REPO_ROOT, 'src', 'content', 'albums');

const WIDTHS = [480, 960, 1600, 2400];
const FORMATS = ['avif', 'webp', 'jpg'];
const QUALITY = { avif: 50, webp: 75, jpg: 82 };
const THUMB_SIZE = 200;
const CONCURRENCY = Math.max(1, cpus().length);

async function loadConfig() {
  const cfgPath = resolve(REPO_ROOT, '.config.yaml');
  const text = await readFile(cfgPath, 'utf8');
  const cfg = yaml.load(text);
  if (!cfg?.content_root) throw new Error('.config.yaml missing content_root');
  return { contentRoot: resolve(cfg.content_root) };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function hashFile(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) {
      h.update(chunk);
      yield chunk;
    }
  });
  return h.digest('hex');
}

function expectedOutputs(imageId, applicableWidths) {
  const paths = [];
  for (const w of applicableWidths) {
    for (const fmt of FORMATS) {
      paths.push(resolve(DERIV_DIR, imageId, `${w}.${fmt}`));
    }
  }
  for (const fmt of FORMATS) {
    paths.push(resolve(DERIV_DIR, imageId, `thumb.${fmt}`));
  }
  return paths;
}

async function allExist(paths) {
  for (const p of paths) {
    try {
      await stat(p);
    } catch {
      return false;
    }
  }
  return true;
}

function encoderFor(fmt) {
  if (fmt === 'avif') return (img) => img.avif({ quality: QUALITY.avif, effort: 4 });
  if (fmt === 'webp') return (img) => img.webp({ quality: QUALITY.webp });
  return (img) => img.jpeg({ quality: QUALITY.jpg, mozjpeg: true });
}

function projectExif(parsed) {
  if (!parsed) return undefined;
  const out = {};
  if (parsed.Make) out.make = String(parsed.Make).trim();
  if (parsed.Model) out.model = String(parsed.Model).trim();
  if (parsed.LensModel) out.lens = String(parsed.LensModel).trim();
  else if (parsed.Lens) out.lens = String(parsed.Lens).trim();
  if (typeof parsed.FNumber === 'number') out.aperture = `f/${parsed.FNumber.toFixed(1).replace(/\.0$/, '')}`;
  if (typeof parsed.ISO === 'number') out.iso = parsed.ISO;
  if (typeof parsed.ExposureTime === 'number') {
    out.shutter = parsed.ExposureTime >= 1
      ? `${parsed.ExposureTime}s`
      : `1/${Math.round(1 / parsed.ExposureTime)}`;
  }
  if (typeof parsed.FocalLength === 'number') out.focal_length = `${Math.round(parsed.FocalLength)}mm`;
  const date = parsed.DateTimeOriginal || parsed.CreateDate || parsed.DateTime;
  if (date instanceof Date) out.date_taken = date.toISOString();
  else if (typeof date === 'string') out.date_taken = date;
  return Object.keys(out).length > 0 ? out : undefined;
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function encodeOne({ srcPath, imageId, applicableWidths, intrinsicWidth }) {
  const outDir = resolve(DERIV_DIR, imageId);
  await ensureDir(outDir);

  const sourceBuf = await readFile(srcPath);

  for (const w of applicableWidths) {
    for (const fmt of FORMATS) {
      const outPath = resolve(outDir, `${w}.${fmt}`);
      const pipeline = sharp(sourceBuf, { failOn: 'none' })
        .rotate()
        .resize({ width: w, withoutEnlargement: true });
      await encoderFor(fmt)(pipeline).toFile(outPath);
    }
  }

  for (const fmt of FORMATS) {
    const outPath = resolve(outDir, `thumb.${fmt}`);
    const pipeline = sharp(sourceBuf, { failOn: 'none' })
      .rotate()
      .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'cover', position: 'attention' });
    await encoderFor(fmt)(pipeline).toFile(outPath);
  }
}

async function readMetadata(srcPath) {
  const meta = await sharp(srcPath).rotate().metadata();
  const exif = await exifr.parse(srcPath, {
    tiff: true,
    exif: true,
    iptc: false,
    xmp: false,
    gps: false,
  }).catch(() => null);
  return { meta, exif };
}

async function processImage({ src, imageId }, cache, results) {
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat) {
    return { status: 'missing', imageId, src };
  }
  const { meta, exif } = await readMetadata(src);
  const intrinsicWidth = meta.width ?? 0;
  const intrinsicHeight = meta.height ?? 0;
  const applicableWidths = WIDTHS.filter((w) => w <= intrinsicWidth);
  if (applicableWidths.length === 0 && intrinsicWidth > 0) {
    applicableWidths.push(intrinsicWidth);
  }
  const outputs = expectedOutputs(imageId, applicableWidths);

  const hash = await hashFile(src);
  const cached = cache[imageId];
  const cacheHit = cached?.hash === hash && (await allExist(outputs));

  if (!cacheHit) {
    await encodeOne({ srcPath: src, imageId, applicableWidths, intrinsicWidth });
  }

  results[imageId] = {
    width: intrinsicWidth,
    height: intrinsicHeight,
    formats: FORMATS,
    widths: applicableWidths,
    exif: projectExif(exif),
  };
  cache[imageId] = { hash };
  return { status: cacheHit ? 'cached' : 'encoded', imageId };
}

async function collectJobs(contentRoot) {
  const files = await readdir(ALBUMS_DIR).catch(() => []);
  const jobs = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const album = JSON.parse(await readFile(resolve(ALBUMS_DIR, f), 'utf8'));
    for (const img of album.images) {
      jobs.push({
        src: resolve(contentRoot, album.url_path.replace(/^\//, ''), img.filename),
        imageId: img.image_id,
      });
    }
  }
  return jobs;
}

async function runPool(jobs, worker) {
  const queue = [...jobs];
  const inflight = new Set();
  let cached = 0;
  let encoded = 0;
  let missing = 0;

  async function next() {
    const job = queue.shift();
    if (!job) return;
    const p = worker(job).then((res) => {
      if (res.status === 'cached') cached += 1;
      else if (res.status === 'encoded') encoded += 1;
      else if (res.status === 'missing') {
        missing += 1;
        console.warn(`  missing source: ${res.src}`);
      }
      const done = cached + encoded + missing;
      if (done % 25 === 0 || done === jobs.length) {
        process.stdout.write(`\r  processed ${done}/${jobs.length} (encoded ${encoded}, cached ${cached}, missing ${missing})`);
      }
    }).finally(() => {
      inflight.delete(p);
    });
    inflight.add(p);
  }

  for (let i = 0; i < Math.min(CONCURRENCY, jobs.length); i++) await next();
  while (inflight.size > 0) {
    await Promise.race(inflight);
    await next();
  }
  process.stdout.write('\n');
  return { cached, encoded, missing };
}

async function main() {
  const { contentRoot } = await loadConfig();
  await ensureDir(DERIV_DIR);

  const jobs = await collectJobs(contentRoot);
  if (jobs.length === 0) {
    console.log('process_images: no images to process (src/content/albums/*.json is empty or missing).');
    await writeFile(META_PATH, '{}');
    return;
  }

  console.log(`process_images: ${jobs.length} images, concurrency=${CONCURRENCY}`);
  const cache = await readJson(CACHE_PATH, {});
  const results = {};

  const summary = await runPool(jobs, (job) => processImage(job, cache, results));

  await writeFile(META_PATH, JSON.stringify(results, null, 2));
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));

  console.log(`  encoded ${summary.encoded}, cached ${summary.cached}, missing ${summary.missing}`);
  console.log(`  wrote ${META_PATH}`);
}

main().catch((err) => {
  console.error('process_images failed:', err.message);
  process.exit(1);
});
