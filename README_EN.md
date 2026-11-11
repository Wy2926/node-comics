# NodeLane Comics

[简体中文](README.md) · [Download](https://comics.nodelane.net/) · [Issues](https://github.com/Wy2926/node-comics/issues)

A comic reader and image translation extension for Chrome, Edge and Firefox. Read local files, Google Drive, OPDS and supported websites with offline caching and saved progress. Use the hosted service, browser-local processing or a self-hosted manga-translator-ui.

## Development

Node.js 22.12+, from `apps/extension`:

```sh
npm ci
npm run dev
npm run check
npm test
npm run build
```

Load `apps/extension/.output/chrome-mv3/` as an unpacked extension. See the [extension guide](apps/extension/README.md).

The API, website and admin UI live in `node-comics-backend`; GPU nodes and the image engine live in `node-comics-compute`. This repository builds independently and connects over HTTP.

[GPL-3.0-only](LICENSE). Third-party licenses and content ownership remain applicable.
