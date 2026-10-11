import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  cacheDir: 'node_modules/.vite-document-fixture',
  resolve: { alias: [{ find: /^(?:\.\.\/lib|\.)\/auth$/, replacement: fileURLToPath(new URL('./document-fixture-auth.ts', import.meta.url)) }] },
  server: { host: '127.0.0.1', port: 5194, strictPort: true },
});
