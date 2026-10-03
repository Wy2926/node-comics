import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';
import { epubRangeFixture } from './fixtures/opds-epub-server';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';

/** Isolated HTTP preview with the same synthetic Range fixture as the integration test. */
export default mergeConfig(base, defineConfig({
  server: { host: '127.0.0.1', port: 5198, strictPort: true, hmr: false },
  plugins: [{
    name: 'epub-range-fixture',
    async configureServer(server) {
      const fixture = await epubRangeFixture();
      // Explicit local-only sample, never copied into the repository or sent to a channel.
      const sample = process.env.NC_EPUB_SAMPLE;
      const sampleSize = sample ? (await stat(sample)).size : 0;
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (path === '/local.epub' && sample) {
          res.writeHead(200, {'Content-Type': 'application/epub+zip', 'Content-Length': sampleSize, 'Cache-Control': 'no-store'});
          createReadStream(sample).pipe(res);
        } else if (/^\/(opds|metrics|[\w-]+\.epub|progress\/[\w-]+)$/.test(path)) fixture.handle(req, res);
        else next();
      });
    },
  }],
}));
