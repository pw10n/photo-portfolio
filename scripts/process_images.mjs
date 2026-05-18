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
import sharp from 'sharp';
import exifr from 'exifr';
import { loadConfig } from './_config.mjs';

// One libvips thread per sharp call. We run N workers in parallel below,
// so total threads = N (not N × cores). Massively reduces context-switching.
sharp.concurrency(1);

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ALBUMS_DIR = resolve(REPO_ROOT, 'src', 'content', 'albums');

const WIDTHS = [480, 960, 1600, 2400];
const FORMATS = ['avif', 'webp', 'jpg'];
const QUALITY = { avif: 50, webp: 75, jpg: 82 };
const THUMB_SIZE = 200;

// Default: cap at 8 (most Macs have <= 8 perf cores; diminishing returns above).
// Override with CONCURRENCY env var for bigger boxes.
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(8, cpus().length));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || DEFAULT_CONCURRENCY);

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
  for await (const chunk of createReadStream(path)) {
    h.update(chunk);
  }
  return h.digest('hex');
}

function expectedOutputs(derivDir, imageId, applicableWidths) {
  const paths = [];
  for (const w of applicableWidths) {
    for (const fmt of FORMATS) {
      paths.push(resolve(derivDir, imageId, `${w}.${fmt}`));
    }
  }
  for (const fmt of FORMATS) {
    paths.push(resolve(derivDir, imageId, `thumb.${fmt}`));
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

async function encodeOne({ srcPath, imageId, applicableWidths, intrinsicWidth, derivDir }) {
  const outDir = resolve(derivDir, imageId);
  await ensureDir(outDir);

  const sourceBuf = await readFile(srcPath);

  // Decode + EXIF-rotate once. Downstream resizes work from the raw buffer
  // without re-decoding the JPEG for every width/format combination.
  const sourceRaw = await sharp(sourceBuf, { failOn: 'none' })
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sourceRawOpts = { raw: { width: sourceRaw.info.width, height: sourceRaw.info.height, channels: sourceRaw.info.channels } };

  // Per width: resize once, then encode 3 formats from that intermediate.
  for (const w of applicableWidths) {
    const resized = await sharp(sourceRaw.data, sourceRawOpts)
      .resize({ width: w, withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const resizedOpts = { raw: { width: resized.info.width, height: resized.info.height, channels: resized.info.channels } };

    for (const fmt of FORMATS) {
      const outPath = resolve(outDir, `${w}.${fmt}`);
      await encoderFor(fmt)(sharp(resized.data, resizedOpts)).toFile(outPath);
    }
  }

  // Thumbnail: square cover with attention-based crop, then 3 formats.
  const thumbResized = await sharp(sourceRaw.data, sourceRawOpts)
    .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'cover', position: 'attention' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const thumbOpts = { raw: { width: thumbResized.info.width, height: thumbResized.info.height, channels: thumbResized.info.channels } };

  for (const fmt of FORMATS) {
    const outPath = resolve(outDir, `thumb.${fmt}`);
    await encoderFor(fmt)(sharp(thumbResized.data, thumbOpts)).toFile(outPath);
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

async function processImage({ src, imageId }, ctx) {
  const { cache, results, derivDir } = ctx;
  try {
    log('processImage start ' + imageId);
    const srcStat = await stat(src).catch(() => null);
    if (!srcStat) {
      log('processImage missing ' + imageId);
      return { status: 'missing', imageId, src };
    }
    log('processImage stat ok ' + imageId);
    const { meta, exif } = await readMetadata(src);
    log('processImage meta ' + imageId + ' ' + meta.width + 'x' + meta.height);
    const intrinsicWidth = meta.width ?? 0;
    const intrinsicHeight = meta.height ?? 0;
    const applicableWidths = WIDTHS.filter((w) => w <= intrinsicWidth);
    if (applicableWidths.length === 0 && intrinsicWidth > 0) {
      applicableWidths.push(intrinsicWidth);
    }
    const outputs = expectedOutputs(derivDir, imageId, applicableWidths);

    const hash = await hashFile(src);
    log('processImage hash ' + imageId);
    const cached = cache[imageId];
    const cacheHit = cached?.hash === hash && (await allExist(outputs));
    log('processImage cacheHit=' + cacheHit + ' ' + imageId);

    if (!cacheHit) {
      await encodeOne({ srcPath: src, imageId, applicableWidths, intrinsicWidth, derivDir });
      log('processImage encoded ' + imageId);
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
  } catch (err) {
    return { status: 'errored', imageId, src, error: err?.message || String(err) };
  }
}

async function collectJobs(contentDir) {
  const files = await readdir(ALBUMS_DIR).catch(() => []);
  const jobs = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const album = JSON.parse(await readFile(resolve(ALBUMS_DIR, f), 'utf8'));
    for (const img of album.images) {
      jobs.push({
        src: resolve(contentDir, album.url_path.replace(/^\//, ''), img.filename),
        imageId: img.image_id,
      });
    }
  }
  return jobs;
}

const DEBUG = process.env.DEBUG_POOL === '1';
const log = (...a) => DEBUG && console.log('[pool]', ...a);

async function runPool(jobs, worker) {
  log('entering runPool, jobs=' + jobs.length + ' concurrency=' + CONCURRENCY);
  const queue = [...jobs];
  const inflight = new Set();
  let cached = 0;
  let encoded = 0;
  let missing = 0;
  let errored = 0;
  const errorSamples = [];

  async function next() {
    const job = queue.shift();
    if (!job) {
      log('next: queue empty');
      return;
    }
    log('next: starting job ' + job.imageId + ' (queue now ' + queue.length + ')');
    const p = (async () => {
      let res;
      try {
        res = await worker(job);
      } catch (err) {
        res = { status: 'errored', imageId: job.imageId, src: job.src, error: err?.message || String(err) };
      }
      log('next: job ' + job.imageId + ' -> ' + res.status);
      if (res.status === 'cached') cached += 1;
      else if (res.status === 'encoded') encoded += 1;
      else if (res.status === 'missing') {
        missing += 1;
        if (missing <= 5) console.warn(`  missing source: ${res.src}`);
      } else if (res.status === 'errored') {
        errored += 1;
        if (errorSamples.length < 5) errorSamples.push(`${res.imageId} (${res.src}): ${res.error}`);
      }
      const done = cached + encoded + missing + errored;
      if (done % 25 === 0 || done === jobs.length) {
        process.stdout.write(`\r  processed ${done}/${jobs.length} (encoded ${encoded}, cached ${cached}, missing ${missing}, errored ${errored})`);
      }
    })().finally(() => {
      log('finally: removing ' + job.imageId + ' from inflight (size=' + inflight.size + ')');
      inflight.delete(p);
    });
    inflight.add(p);
  }

  log('initial fill');
  for (let i = 0; i < Math.min(CONCURRENCY, jobs.length); i++) await next();
  log('initial fill done, inflight=' + inflight.size);
  while (inflight.size > 0) {
    log('awaiting race, inflight=' + inflight.size + ', queue=' + queue.length);
    await Promise.race(inflight);
    log('race resolved, inflight=' + inflight.size);
    await next();
  }
  log('loop exit');
  process.stdout.write('\n');
  return { cached, encoded, missing, errored, errorSamples };
}

async function main() {
  const { contentDir, buildDir } = await loadConfig({ ensureBuildDir: true });
  const derivDir = resolve(buildDir, 'derivatives');
  const metaPath = resolve(buildDir, 'image-meta.json');
  const cachePath = resolve(buildDir, 'derivative-cache.json');
  await ensureDir(derivDir);

  const jobs = await collectJobs(contentDir);
  if (jobs.length === 0) {
    console.log('process_images: no images to process (src/content/albums/*.json is empty or missing).');
    await writeFile(metaPath, '{}');
    return;
  }

  console.log(`process_images: ${jobs.length} images, concurrency=${CONCURRENCY} (cpus=${cpus().length}, sharp.concurrency=1)`);
  console.log(`  build_dir: ${buildDir}`);
  const cache = await readJson(cachePath, {});
  const results = {};

  const summary = await runPool(jobs, (job) => processImage(job, { cache, results, derivDir }));

  await writeFile(metaPath, JSON.stringify(results, null, 2));
  await writeFile(cachePath, JSON.stringify(cache, null, 2));

  console.log(`  encoded ${summary.encoded}, cached ${summary.cached}, missing ${summary.missing}, errored ${summary.errored}`);
  console.log(`  results entries: ${Object.keys(results).length}`);
  console.log(`  wrote ${metaPath}`);
  if (summary.errored > 0) {
    console.log(`  first ${summary.errorSamples.length} errors:`);
    for (const e of summary.errorSamples) console.log(`    ${e}`);
    process.exit(1);
  }
  if (summary.missing > 0) {
    console.log(`  (use a fresh smugmug_download run to fill in missing sources)`);
  }
}

main().catch((err) => {
  console.error('process_images failed:', err.message);
  process.exit(1);
});
