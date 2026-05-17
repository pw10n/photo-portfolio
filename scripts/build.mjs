#!/usr/bin/env node
// Orchestrates the full build chain.
// Per TDD §13.1: verify config → yaml_to_content → process_images → astro build → verify.
// Halts at the first non-zero exit.

import { spawn } from 'node:child_process';
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

async function main() {
  const totalStart = Date.now();
  await verifyConfig();
  await step('yaml_to_content', 'node', ['scripts/yaml_to_content.mjs']);
  await step('process_images', 'node', ['scripts/process_images.mjs']);
  await step('astro build', 'npx', ['--no-install', 'astro', 'build']);
  await step('verify', 'node', ['scripts/verify.mjs']);
  const totalSecs = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n✓ build complete in ${totalSecs}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
