import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// This alias is only loaded by dev:documents, never by the public Astro build.
export default defineConfig({
  cacheDir: 'node_modules/.vite-document-live',
  resolve: { alias: [{ find: /^(?:\.\.\/lib|\.)\/auth$/, replacement: fileURLToPath(new URL('./document-live-auth.ts', import.meta.url)) }] },
  server: {
    host: '127.0.0.1', port: 5195, strictPort: true, open: false, cors: false,
    proxy: { '/v1': { target: 'http://127.0.0.1:4324', changeOrigin: false } },
  },
  plugins: [{ name: 'document-live-entry', configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url === '/' || request.url?.startsWith('/?')) request.url = '/tests/document-live.html' + request.url.slice(1);
      next();
    });
  } }],
});
