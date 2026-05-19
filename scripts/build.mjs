#!/usr/bin/env node
// Orchestrates the full build chain.
// Per TDD §13.1: verify config → yaml_to_content → process_images → astro build → verify.
// Halts at the first non-zero exit.

import { spawn } from 'node:child_process';
import { lstat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './_config.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

async function step(label, cmd, args) {
  const start = Date.now();
  console.log(`\n▶ ${label}`);
  const code = await new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', rej);
    child.on('exit', res);
  });
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  if (code !== 0) {
    console.error(`✗ ${label} failed in ${secs}s (exit ${code})`);
    process.exit(code ?? 1);
  }
  console.log(`✓ ${label} (${secs}s)`);
}

async function verifyConfig() {
  console.log('▶ verify config');
  try {
    const { contentRoot, contentDir, buildDir } = await loadConfig({ ensureBuildDir: true });
    console.log(`✓ verify config`);
    console.log(`  content_root: ${contentRoot}`);
    console.log(`  content_dir:  ${contentDir}`);
    console.log(`  build_dir:    ${buildDir}`);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}

async function stripLocalDerivativesSymlink() {
  // setup_local.mjs symlinks public/derivatives → <buildDir>/derivatives so
  // PROFILE=local builds and dev can serve encoded images. For prod, that
  // symlink must be removed before `astro build` — otherwise Astro follows
  // it and copies ~110 GB / 200k+ files into dist/, blowing past Pages'
  // 25k-file deploy limit. `npm run dev`/`build:local` recreates it.
  const path = resolve(REPO_ROOT, 'public', 'derivatives');
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) {
      await unlink(path);
      console.log(`✓ removed dev symlink: ${path}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function main() {
  const skipProcess = process.argv.includes('--skip-process');
  const totalStart = Date.now();
  await verifyConfig();
  await step('yaml_to_content', 'node', ['scripts/yaml_to_content.mjs']);
  if (skipProcess) {
    console.log('\n⏭  process_images skipped (--skip-process)');
  } else {
    await step('process_images', 'node', ['scripts/process_images.mjs']);
  }
  if (process.env.PROFILE !== 'local') {
    await stripLocalDerivativesSymlink();
  }
  await step('astro build', 'npx', ['--no-install', 'astro', 'build']);
  await step('verify', 'node', ['scripts/verify.mjs']);
  const totalSecs = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n✓ build complete in ${totalSecs}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
