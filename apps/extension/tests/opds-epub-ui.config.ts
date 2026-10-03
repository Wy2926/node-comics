import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';
import { epubRangeFixture } from './fixtures/opds-epub-server';

/** Isolated HTTP preview with the same synthetic Range fixture as the integration test. */
export default mergeConfig(base, defineConfig({
  server: { host: '127.0.0.1', port: 5198, strictPort: true, hmr: false },
  plugins: [{
    name: 'epub-range-fixture',
    async configureServer(server) {
      const fixture = await epubRangeFixture();
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (/^\/(opds|metrics|[\w-]+\.epub|progress\/[\w-]+)$/.test(path)) fixture.handle(req, res);
        else next();
      });
    },
  }],
}));
