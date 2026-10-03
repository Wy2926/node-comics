import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomFillSync } from 'node:crypto';
import { BlobReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/index-native.js';
import {cover} from './remote-library-ui-server';

/** Synthetic EPUB served over real loopback HTTP; no external service or private credentials. */
export async function epubRangeFixture(level: 0 | 6 = 0) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level });
  const paragraph = '<p>Lazy EPUB reading keeps the current chapter available without downloading the entire book. Body text stays in its original language.</p>';
  const chapter = (title: string, start: number) => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link rel="stylesheet" href="style.css"/></head><body><h1>${title}</h1>${Array.from({length: 6}, (_, i) => `<figure><img src="image-${start + i}.png" alt="Original artwork ${start + i}"/><figcaption>Artwork ${start + i} — this caption stays unchanged.</figcaption></figure>${paragraph.repeat(8)}`).join('')}${paragraph.repeat(452)}</body></html>`;
  const files = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'OPS/book.opf': `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Lazy EPUB fixture</dc:title><dc:identifier id="uid">lazy-epub-fixture</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/><item id="attachment" href="attachment.bin" media-type="application/octet-stream"/>${Array.from({length: 12}, (_, i) => `<item id="image-${i + 1}" href="image-${i + 1}.png" media-type="image/png"/>`).join('')}</manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
    'OPS/nav.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">Chapter One</a></li><li><a href="two.xhtml">Chapter Two</a></li></ol></nav></body></html>',
    'OPS/one.xhtml': chapter('Chapter One', 1),
    'OPS/two.xhtml': chapter('Chapter Two', 7),
    'OPS/style.css': 'body { font-family: serif; } h1 { color: inherit; } figure { margin: 24px 0; } img { max-width: 100%; height: auto; } figcaption { font-size: .85em; }',
    ...Object.fromEntries(Array.from({length: 12}, (_, i) => [`OPS/image-${i + 1}.png`, cover(i)])),
    // Incompressible attachment makes accidental whole-container reads measurable in both ZIP modes.
    'OPS/attachment.bin': randomFillSync(new Uint8Array(3 * 1024 ** 2)),
  };
  for (const [name, value] of Object.entries(files)) {
    await writer.add(name, new BlobReader(new Blob([value])), { level: name === 'mimetype' ? 0 : level });
  }
  const bytes = await writer.close();
  const requests: { path: string; range?: string; ifMatch?: string; ifUnmodifiedSince?:string; status: number; bytes: number }[] = [];
  const state = { etag: '"fixture-v1"', lastModified:'Mon, 01 Jan 2024 00:00:00 GMT', fail: 0 };
  const publications=['book', 'no-range', 'weak', 'last-modified', 'weak-modified', 'fresh-modified', 'sync-fails', 'sync-unsupported', 'denied', 'expired'];
  function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-Match, If-Unmodified-Since');
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Last-Modified, Date, Content-Range, Content-Length');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if(path.startsWith('/progress/')) {
      const status=path.endsWith('sync-unsupported')?404:503;
      requests.push({path,status,bytes:0});res.writeHead(status).end();return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/opds') {
      res.setHeader('Content-Type', 'application/opds+json');
      res.end(JSON.stringify({
        metadata: { title: 'EPUB Range test library' },
        publications: publications.map((id) => ({
          metadata: { title: 'EPUB ' + id, identifier: id },
          links: [{ href: `/${id}.epub`, rel: 'http://opds-spec.org/acquisition', type: 'application/epub+zip' },
            ...(id.startsWith('sync-')?[{href:`/progress/${id}`,rel:'http://www.cantook.com/api/progression',type:'application/vnd.readium.progression+json'}]:[])],
        })),
      }));
      return;
    }
    if (path === '/metrics') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ size: bytes.length, requests }));
      return;
    }
    if (!publications.some(id=>path===`/${id}.epub`)) { res.writeHead(404).end(); return; }
    const range = req.headers.range, ifMatch = req.headers['if-match'] as string | undefined;
    const ifUnmodifiedSince=req.headers['if-unmodified-since'] as string|undefined;
    const denied = path === '/denied.epub' ? 403 : path === '/expired.epub' ? 401 : state.fail;
    const fail = denied || (ifMatch && ifMatch !== state.etag || ifUnmodifiedSince && ifUnmodifiedSince!==state.lastModified ? 412 : 0);
    if (fail) {
      requests.push({ path, range, ifMatch, ifUnmodifiedSince, status: fail, bytes: 0 });
      res.writeHead(fail).end(); return;
    }
    res.setHeader('Content-Type', 'application/epub+zip');
    if(!path.includes('modified')||path==='/weak-modified.epub')res.setHeader('ETag', path.startsWith('/weak') ? 'W/' + state.etag : state.etag);
    if(path.includes('modified'))res.setHeader('Last-Modified',path==='/fresh-modified.epub'?new Date().toUTCString():state.lastModified);
    if (path === '/no-range.epub' || !range) {
      requests.push({ path, range, ifMatch, status: 200, bytes: bytes.length });
      res.setHeader('Content-Length', bytes.length);
      res.end(bytes); return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match || Number(match[2]) >= bytes.length || Number(match[1]) > Number(match[2])) { res.writeHead(416).end(); return; }
    const start = Number(match[1]), end = Number(match[2]), data = bytes.subarray(start, end + 1);
    requests.push({ path, range, ifMatch, ifUnmodifiedSince, status: 206, bytes: data.length });
    res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    res.setHeader('Content-Length', data.length);
    res.writeHead(206).end(data);
  }
  return { bytes, requests, state, handle };
}

export async function startEpubRangeServer(level: 0 | 6 = 0) {
  const fixture = await epubRangeFixture(level), server = createServer(fixture.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Loopback server did not start');
  return {
    ...fixture,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
