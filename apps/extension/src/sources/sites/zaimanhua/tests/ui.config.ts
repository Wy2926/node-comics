import {Readable} from 'node:stream';
import {defineConfig, mergeConfig} from 'vite';
import base from '../../../../../vite.config';

// Local UI acceptance only: real public bodies, no auth forwarding, GET-only relay.
export default mergeConfig(base, defineConfig({
  server: {host: '127.0.0.1', port: 5203, strictPort: true},
  plugins: [{
    name: 'zaimanhua-live-ui',
    transformIndexHtml: {order: 'pre', handler: html => html.replace('src="/src/main.tsx"', 'src="/src/sources/sites/zaimanhua/tests/ui.ts"')},
    configureServer(server) {
      server.middlewares.use('/__zai_live', async (req, res) => {
        try {
          const target = new URL(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('url') ?? '');
          const metadata = ['www.zaimanhua.com', 'manhua.zaimanhua.com'].includes(target.hostname)
            && /^\/(?:api\/v1\/comic[12]\/(?:comic|chapter)\/detail|app\/v1\/search\/index)$/.test(target.pathname);
          const image = target.hostname === 'images.zaimanhua.com';
          if (req.method !== 'GET' || target.protocol !== 'https:' || target.port || target.username || target.password || (!metadata && !image)) {
            res.statusCode = 403; res.end('Public GET only'); return;
          }
          const controller = new AbortController(); res.on('close', () => controller.abort());
          const response = await fetch(target, {redirect: 'error', headers: {Referer: 'https://www.zaimanhua.com/'},
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])});
          res.statusCode = response.status; res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          if (response.body) Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).on('error', () => res.destroy()).pipe(res);
          else res.end();
        } catch {if (!res.headersSent) {res.statusCode = 502; res.end('Source unavailable');} else res.destroy();}
      });
    },
  }],
}));
