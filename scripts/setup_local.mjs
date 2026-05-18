#!/usr/bin/env node
// Idempotent local-dev setup:
//   1. Symlinks public/derivatives → <content_root>/build/derivatives so the
//      Astro dev server can serve encoded images at /derivatives/<id>/...
//   2. Touches <content_root>/site.local.yaml if absent (the loader has
//      sensible built-in defaults for `local`, so the file is optional —
//      but having it as a stub makes it discoverable when the user wants
//      to override the hero text or site_url).
//
// Run automatically by `npm run dev` / `npm run build:local`. Safe to
// re-run; no destructive operations.

import { stat, mkdir, symlink, unlink, readlink, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './_config.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureSymlink(linkPath, target) {
  const linkDir = dirname(linkPath);
  await mkdir(linkDir, { recursive: true });
  try {
    const existing = await readlink(linkPath);
    if (existing === target) {
      console.log(`  ✓ symlink already correct: ${linkPath} → ${target}`);
      return;
    }
    await unlink(linkPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Not a symlink — could be a real file/directory we don't want to nuke.
      throw new Error(`${linkPath} exists and is not a symlink. Remove it first.`);
    }
  }
  await symlink(target, linkPath);
  console.log(`  ✓ created symlink: ${linkPath} → ${target}`);
}

async function ensureLocalSiteYaml(contentRoot) {
  const path = resolve(contentRoot, 'site.local.yaml');
  if (await pathExists(path)) {
    console.log(`  ✓ ${path} already exists`);
    return;
  }
  const contents = [
    `# Local-dev overrides for site.yaml. Loaded when PROFILE=local.`,
    `# Optional — if this file is missing, built-in defaults apply:`,
    `#   site_url: http://localhost:4321`,
    `#   assets_base_url: ""   # served via public/derivatives symlink`,
    `#`,
    `# Uncomment to override base values:`,
    `# site_url: http://localhost:4321`,
    `# assets_base_url: ""`,
    `# homepage:`,
    `#   hero_title: "Local Dev"`,
    `#   hero_subtitle: "Built from your real content."`,
    ``,
  ].join('\n');
  await writeFile(path, contents);
  console.log(`  ✓ wrote stub: ${path}`);
}

async function main() {
  console.log('setup_local: ensuring local dev infrastructure');
  const { contentRoot, buildDir } = await loadConfig({ requireContentDir: false });
  console.log(`  content_root: ${contentRoot}`);

  // 1. derivatives symlink
  const symlinkPath = resolve(REPO_ROOT, 'public', 'derivatives');
  const symlinkTarget = resolve(buildDir, 'derivatives');
  await ensureSymlink(symlinkPath, symlinkTarget);

  // 2. site.local.yaml stub (optional, but discoverable)
  await ensureLocalSiteYaml(contentRoot);

  console.log('done.');
}

main().catch((err) => {
  console.error('setup_local failed:', err.message);
  process.exit(1);
});
