import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { loadSiteSync } from './scripts/_site.mjs';

// Site config is loaded from <content_root>/site.yaml, with optional
// <content_root>/site.<profile>.yaml overrides when PROFILE env var is set.
// PROFILE=local has built-in defaults (site_url=localhost, assets_base_url='').
const site = loadSiteSync();

export default defineConfig({
  site: site.site_url,
  integrations: [react()],
  build: {
    format: 'directory',
  },
  vite: {
    define: {
      'import.meta.env.PUBLIC_ASSETS_BASE_URL': JSON.stringify(site.assets_base_url),
    },
    build: {
      assetsInlineLimit: 0,
    },
  },
});
