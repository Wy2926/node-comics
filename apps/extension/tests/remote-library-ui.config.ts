import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config';
import { remoteLibraryUiFixture } from './fixtures/remote-library-ui-server';

/** UI-only isolated catalog. The production OPDS provider and main app are unchanged. */
export default mergeConfig(base, defineConfig({
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  plugins: [{
    name: 'remote-library-ui-fixture',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replace('src="/src/main.tsx"', 'src="/tests/remote-library-ui.ts"') },
    async configureServer(server) {
      const fixture = await remoteLibraryUiFixture();
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (/^\/opds(?:-other)?(?:\/|$)/.test(path) || path.startsWith('/fixture-assets/') || path === '/__remote_ui_metrics') fixture.handle(req, res);
        else next();
      });
    },
  }],
}));
