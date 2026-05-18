#!/usr/bin/env node
// Idempotent Cloudflare provisioning via wrangler.
//
// Creates (if not already present):
//   1. R2 bucket  (R2_BUCKET)
//   2. R2 public custom domain (R2_PUBLIC_HOSTNAME on the bucket)
//   3. Pages project (CF_PAGES_PROJECT) — production branch = main
//
// Re-runs are safe: "already exists" errors are treated as success.
//
// Two things this script can NOT automate (Cloudflare doesn't expose APIs):
//   • Creating the R2 S3 access key pair (AWS_ACCESS_KEY_ID/SECRET).
//   • Creating the bootstrap CLOUDFLARE_API_TOKEN itself.
// Both come from the CF dashboard. See README/DEPLOY.md for the exact clicks.

import { spawn } from 'node:child_process';

const REQUIRED_ENV = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'R2_BUCKET',
  'R2_PUBLIC_HOSTNAME',
  'CF_PAGES_PROJECT',
];

// Strip leftmost subdomain to get the apex zone name.
// `assets.prenticew.com` → `prenticew.com`. Override with CF_ZONE_NAME if
// your hostname has a different subdomain depth.
function deriveZoneName(hostname) {
  const parts = hostname.split('.');
  return parts.length > 2 ? parts.slice(1).join('.') : hostname;
}

async function lookupZoneId(zoneName) {
  const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
  });
  const body = await res.json();
  if (!body.success) {
    const msg = body.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(`zone lookup failed for ${zoneName}: ${msg}`);
  }
  if (!body.result || body.result.length === 0) {
    throw new Error(
      `no zone found for "${zoneName}". Either the zone isn't on this CF account, ` +
      `or the API token lacks Zone:Read on it. ` +
      `Set CF_ZONE_NAME in .env if your zone name differs from the derived one.`,
    );
  }
  return body.result[0].id;
}

function checkEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars in .env: ${missing.join(', ')}`);
    console.error(`See .env.example for the full list and where to obtain each.`);
    process.exit(1);
  }
}

// Run wrangler. Returns { code, stdout, stderr }. Never throws on non-zero.
function wrangler(args) {
  return new Promise((resolveP) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('close', (code) => resolveP({ code, stdout, stderr }));
  });
}

// Treat these stderr patterns as benign idempotency signals, not failures.
const ALREADY_EXISTS_PATTERNS = [
  /already exists/i,
  /bucket with this name exists/i,
  /A project with this name already exists/i,
  /domain.*already.*(connected|added|attached|in use)/i,
  /custom domain.*already/i,
];

function isAlreadyExists(stderr) {
  return ALREADY_EXISTS_PATTERNS.some((re) => re.test(stderr));
}

async function step(label, args) {
  process.stdout.write(`▶ ${label} ... `);
  const { code, stdout, stderr } = await wrangler(args);
  if (code === 0) {
    console.log('ok');
    return;
  }
  if (isAlreadyExists(stderr)) {
    console.log('already exists (ok)');
    return;
  }
  console.log('failed');
  console.error(`  wrangler ${args.join(' ')}`);
  if (stdout.trim()) console.error(`  stdout: ${stdout.trim()}`);
  if (stderr.trim()) console.error(`  stderr: ${stderr.trim()}`);
  process.exit(code ?? 1);
}

async function main() {
  checkEnv();
  const bucket = process.env.R2_BUCKET;
  const hostname = process.env.R2_PUBLIC_HOSTNAME;
  const project = process.env.CF_PAGES_PROJECT;
  const zoneName = process.env.CF_ZONE_NAME || deriveZoneName(hostname);

  console.log('cf_setup: provisioning Cloudflare resources');
  console.log(`  R2 bucket:        ${bucket}`);
  console.log(`  R2 public domain: ${hostname}  (zone: ${zoneName})`);
  console.log(`  Pages project:    ${project}\n`);

  let zoneId = process.env.CF_ZONE_ID;
  if (zoneId) {
    console.log(`▶ using CF_ZONE_ID from .env: ${zoneId}`);
  } else {
    process.stdout.write(`▶ resolve zone id for ${zoneName} via API ... `);
    try {
      zoneId = await lookupZoneId(zoneName);
      console.log(zoneId);
    } catch (err) {
      console.log('failed');
      console.error(`  ${err.message}`);
      console.error(`  workaround: grab the zone ID from the CF dashboard (visible in the sidebar of any page inside the zone) and add CF_ZONE_ID=<id> to .env, then re-run.`);
      process.exit(1);
    }
  }

  await step('create R2 bucket', ['r2', 'bucket', 'create', bucket]);
  await step(
    `attach ${hostname} to ${bucket}`,
    ['r2', 'bucket', 'domain', 'add', bucket,
     '--domain', hostname, '--zone-id', zoneId, '--force'],
  );
  await step(
    'create Pages project',
    ['pages', 'project', 'create', project, '--production-branch=main'],
  );

  console.log('\n✓ cf_setup complete');
  console.log('\nNext steps:');
  console.log('  1. npm run build         # generate dist/');
  console.log('  2. npm run publish       # upload to R2 + deploy to Pages');
  console.log('  3. Attach a custom domain to the Pages project once deployed:');
  console.log('       npx wrangler pages deployment domain add \\');
  console.log(`         --project-name=${project} ${process.env.CF_PAGES_SHADOW_HOSTNAME || 'sgallery.prenticew.com'}`);
}

main().catch((err) => {
  console.error('cf_setup failed:', err.message);
  process.exit(1);
});
