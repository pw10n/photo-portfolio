import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { loadSiteSync } from './scripts/_site.mjs';

const site = loadSiteSync();
// Env var overrides site.yaml so local dev can set PUBLIC_ASSETS_BASE_URL=/
// in .env to serve derivatives via the dev server (public/derivatives symlink).
const assetsBaseUrl = process.env.PUBLIC_ASSETS_BASE_URL ?? site.assets_base_url;

export default defineConfig({
  site: site.site_url,
  integrations: [react()],
  build: {
    format: 'directory',
  },
  vite: {
    define: {
      'import.meta.env.PUBLIC_ASSETS_BASE_URL': JSON.stringify(assetsBaseUrl),
    },
    build: {
      assetsInlineLimit: 0,
    },
  },
});
