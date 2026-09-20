import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { site } from './src/data/site';

export default defineConfig({
  site: site.url,
  output: 'static',
  trailingSlash: 'always',
  integrations: [react()],
  build: { inlineStylesheets: 'never' },
  vite: { build: { sourcemap: false } },
});
