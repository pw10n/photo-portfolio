#!/usr/bin/env node
// Upload derivatives + originals to R2 (delta-only, via per-key sha256 cache),
// then `wrangler pages deploy dist/`.
//
// Per TDD §13.2. The upload-cache.json lives next to derivative-cache.json
// under <content_root>/build/ so both caches share a lifecycle.
//
// Idempotent: a partial run can be resumed by re-running. R2 keys are
// content-addressed by image_id, so worst-case duplicate uploads are bytes
// already present on the server — no risk of stale-content collisions.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { loadConfig } from './_config.mjs';

const REQUIRED_ENV = [
  'CLOUDFLARE_ACCOUNT_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'CF_PAGES_PROJECT',
  'CLOUDFLARE_API_TOKEN',
];

const CONCURRENCY = Number(process.env.PUBLISH_CONCURRENCY) || 16;
const CACHE_FLUSH_EVERY = 200;

const CONTENT_TYPES = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    console.error('See .env.example for setup instructions.');
    process.exit(1);
  }
}

function makeS3Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

function contentTypeFor(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  if (m < 60) return `${m}m${ss}s`;
  const h = Math.floor(m / 60);
  const mm = (m % 60).toString().padStart(2, '0');
  return `${h}h${mm}m${ss}s`;
}

function etaString(done, total, startMs) {
  if (done === 0) return '–';
  const elapsed = Date.now() - startMs;
  const remaining = (elapsed / done) * (total - done);
  return fmtDuration(remaining);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

async function* walkFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const path = resolve(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(path);
    else if (e.isFile()) yield path;
  }
}

// Build the full upload job list: derivatives + originals.
async function collectJobs({ contentDir, buildDir, repoRoot }) {
  const jobs = [];

  // Derivatives: <buildDir>/derivatives/<image_id>/<file>
  const derivRoot = resolve(buildDir, 'derivatives');
  for await (const localPath of walkFiles(derivRoot)) {
    const rel = localPath.slice(derivRoot.length + 1); // e.g. "abc123/1600.avif"
    jobs.push({
      kind: 'derivative',
      localPath,
      r2Key: `derivatives/${rel}`,
      contentType: contentTypeFor(localPath),
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  // Originals: enumerated via src/content/albums/*.json
  const albumsDir = resolve(repoRoot, 'src', 'content', 'albums');
  let albumFiles = [];
  try {
    albumFiles = (await readdir(albumsDir)).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const f of albumFiles) {
    const album = JSON.parse(await readFile(resolve(albumsDir, f), 'utf8'));
    const albumDir = resolve(contentDir, album.url_path.replace(/^\//, ''));
    for (const img of album.images) {
      const localPath = resolve(albumDir, img.filename);
      jobs.push({
        kind: 'original',
        localPath,
        r2Key: `originals/${img.image_id}/${img.filename}`,
        contentType: contentTypeFor(img.filename),
        contentDisposition: `attachment; filename="${img.filename}"`,
        cacheControl: 'public, max-age=31536000, immutable',
      });
    }
  }

  return jobs;
}

async function runUploads(jobs, s3, bucket, cache, cachePath) {
  const queue = [...jobs];
  let uploaded = 0;
  let cached = 0;
  let missing = 0;
  let errored = 0;
  const errorSamples = [];
  let processed = 0;
  let bytesUploaded = 0;
  const start = Date.now();

  async function worker() {
    while (true) {
      const job = queue.shift();
      if (!job) return;

      // Pre-hash check: if cache says this key has the same source-sha we
      // are about to compute, we can skip. We still hash to verify (cheap
      // for small files). For originals (~37 MB max) the hash is ~1 s.
      const buf = await readFile(job.localPath).catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (buf === null) {
        missing += 1;
        processed += 1;
        continue;
      }
      const hash = createHash('sha256').update(buf).digest('hex');
      if (cache[job.r2Key] === hash) {
        cached += 1;
        processed += 1;
        continue;
      }

      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: job.r2Key,
            Body: buf,
            ContentType: job.contentType,
            CacheControl: job.cacheControl,
            ...(job.contentDisposition ? { ContentDisposition: job.contentDisposition } : {}),
          }),
        );
        cache[job.r2Key] = hash;
        uploaded += 1;
        bytesUploaded += buf.byteLength;
      } catch (err) {
        errored += 1;
        if (errorSamples.length < 5) {
          errorSamples.push(`${job.r2Key}: ${err.message}`);
        }
      }
      processed += 1;

      if (processed % CACHE_FLUSH_EVERY === 0) {
        await writeJsonAtomic(cachePath, cache);
      }
      if (processed % 50 === 0 || processed === jobs.length) {
        const elapsed = fmtDuration(Date.now() - start);
        const eta = etaString(processed, jobs.length, start);
        process.stdout.write(
          `\r  ${processed}/${jobs.length} ` +
            `(uploaded ${uploaded}, cached ${cached}, missing ${missing}, errored ${errored}) ` +
            `${(bytesUploaded / 1024 / 1024).toFixed(1)} MiB · ${elapsed} elapsed · ${eta} eta   `,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await writeJsonAtomic(cachePath, cache);
  process.stdout.write('\n');

  return { uploaded, cached, missing, errored, errorSamples };
}

function runWranglerDeploy() {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      'npx',
      ['--no-install', 'wrangler', 'pages', 'deploy', 'dist',
       `--project-name=${process.env.CF_PAGES_PROJECT}`],
      { stdio: 'inherit', env: process.env },
    );
    child.on('error', rejectP);
    child.on('exit', (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`wrangler pages deploy exited ${code}`));
    });
  });
}

async function main() {
  const skipR2 = process.argv.includes('--skip-r2');

  checkEnv();
  const { contentDir, buildDir, repoRoot } = await loadConfig();

  // Sanity-check dist/ exists before we bother uploading.
  const distDir = resolve(repoRoot, 'dist');
  const distStat = await stat(distDir).catch(() => null);
  if (!distStat?.isDirectory()) {
    console.error('dist/ not found. Run `npm run build` first.');
    process.exit(1);
  }

  if (skipR2) {
    console.log('publish: skipping R2 sync (--skip-r2)');
  } else {
    const bucket = process.env.R2_BUCKET;
    const cachePath = resolve(buildDir, 'upload-cache.json');
    const cache = await readJson(cachePath, {});

    console.log('publish: collecting upload jobs');
    const jobs = await collectJobs({ contentDir, buildDir, repoRoot });
    const derivJobs = jobs.filter((j) => j.kind === 'derivative').length;
    const origJobs = jobs.filter((j) => j.kind === 'original').length;
    console.log(`  ${derivJobs} derivatives, ${origJobs} originals (total ${jobs.length})`);
    console.log(`  bucket: ${bucket}  concurrency: ${CONCURRENCY}`);
    console.log(`  cache:  ${cachePath} (${Object.keys(cache).length} entries)`);

    const s3 = makeS3Client();

    console.log('\npublish: uploading');
    const summary = await runUploads(jobs, s3, bucket, cache, cachePath);
    console.log(
      `\n✓ uploaded ${summary.uploaded}, cached ${summary.cached}, ` +
        `missing ${summary.missing}, errored ${summary.errored}`,
    );
    if (summary.errorSamples.length > 0) {
      console.error('first errors:');
      for (const s of summary.errorSamples) console.error(`  ${s}`);
      process.exit(1);
    }
    if (summary.missing > 0) {
      console.warn(`warning: ${summary.missing} source files missing — uploads incomplete`);
    }
  }

  console.log('\npublish: deploying Pages bundle');
  await runWranglerDeploy();
  console.log('\n✓ publish complete');
}

main().catch((err) => {
  console.error('publish failed:', err);
  process.exit(1);
});
