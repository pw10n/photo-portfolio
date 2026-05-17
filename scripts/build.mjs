#!/usr/bin/env node
// Orchestrates the full build chain.
// Per TDD §13.1: verify config → yaml_to_content → process_images → astro build → verify.
// Halts at the first non-zero exit.

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

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
  const cfgPath = resolve(REPO_ROOT, '.config.yaml');
  let text;
  try {
    text = await readFile(cfgPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`✗ .config.yaml not found at ${cfgPath}`);
      console.error('  Copy .config.example.yaml to .config.yaml and set content_root.');
      process.exit(1);
    }
    throw err;
  }
  const cfg = yaml.load(text) ?? {};
  if (!cfg.content_root || typeof cfg.content_root !== 'string') {
    console.error('✗ .config.yaml is missing the required `content_root` key.');
    process.exit(1);
  }
  const cr = resolve(cfg.content_root);
  const st = await stat(cr).catch(() => null);
  if (!st?.isDirectory()) {
    console.error(`✗ content_root does not exist or is not a directory: ${cr}`);
    process.exit(1);
  }
  console.log(`✓ verify config (content_root=${cr})`);
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
