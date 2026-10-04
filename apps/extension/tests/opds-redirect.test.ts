import 'fake-indexeddb/auto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpdsProvider } from '../src/comics/sources/opds/provider';
import { PrivateOpdsStore } from '../src/comics/sources/opds/private-store';
import { registerSourceDriver } from '../src/comics/sources/registry';
import { openFileSource } from '../src/comics/sources/runtime';
import { connectRemoteLibrary, browseRemoteLibrary, openRemotePublication } from '../src/comics/application/remote-library-service';
import { entrySource } from '../src/comics/application/entry-source';
import { removeComic } from '../src/comics/application/library-service';
import { openEpubArchive } from '../src/comics/formats/epub/archive';
import { installTestXmlParser } from './opds-protocol-dom';
import { startEpubRangeServer } from './fixtures/opds-epub-server';

installTestXmlParser();
const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Two actual origins exercise native Fetch redirects, not mocked 302 responses. */
async function setup() {
  const files = await startEpubRangeServer(6);
  cleanup.push(files.close);
  const requests: string[] = [];
  const gateway = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push(url.pathname + url.search);
    const redirects: Record<string, string> = {
      '/opds': '/catalog/feed.json',
      '/search': '/discovery/search.xml',
      '/catalog/entry': '/metadata/book.json',
      '/catalog/loop.epub': '/catalog/loop.epub',
    };
    const destination = redirects[url.pathname] ??
      (/^\/catalog\/[\w-]+\.epub$/.test(url.pathname)
        ? files.origin + url.pathname.replace('/catalog', '') : undefined);
    if (destination) {
      response.writeHead(302, { Location: destination }).end();
      return;
    }
    if (url.pathname === '/catalog/feed.json') {
      response.setHeader('Content-Type', 'application/opds+json');
      response.end(JSON.stringify({
        metadata: { title: 'Redirect library' },
        links: [{ rel: 'search', href: '../search', type: 'application/opensearchdescription+xml' }],
        navigation: [{ href: files.origin + '/opds', title: 'External catalog' }],
        publications: ['book', 'no-range', 'denied', 'expired', 'loop', 'detail'].map((id) => ({
          metadata: { title: id, identifier: id },
          links: [id === 'detail'
            ? { href: 'entry', rel: 'self', type: 'application/opds-publication+json' }
            : { href: id + '.epub', rel: 'http://opds-spec.org/acquisition', type: 'application/epub+zip' }],
        })),
      }));
      return;
    }
    if (url.pathname === '/discovery/search.xml') {
      response.setHeader('Content-Type', 'application/opensearchdescription+xml');
      response.end('<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><Url type="application/opds+json" template="../catalog/feed.json?q={searchTerms}"/></OpenSearchDescription>');
      return;
    }
    if (url.pathname === '/metadata/book.json') {
      response.setHeader('Content-Type', 'application/opds-publication+json');
      response.end(JSON.stringify({
        metadata: { title: 'detail', identifier: 'detail' },
        links: [{ href: '../catalog/book.epub', rel: 'http://opds-spec.org/acquisition', type: 'application/epub+zip' }],
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    gateway.close((error) => error ? reject(error) : resolve());
    gateway.closeAllConnections();
  }));
  const address = gateway.address();
  if (!address || typeof address === 'string') throw Error('Redirect fixture did not start');
  const store = new PrivateOpdsStore('opds-redirect-' + crypto.randomUUID());
  const provider = createOpdsProvider({ store });
  cleanup.push(registerSourceDriver(provider));
  const connection = await connectRemoteLibrary('opds', {
    name: 'Redirect fixture', auth: 'anonymous', url: `http://127.0.0.1:${address.port}/opds`,
  });
  cleanup.push(() => provider.connection!.disconnect!(connection));
  const page = await browseRemoteLibrary(connection.id);
  return { files, provider, connection, page, requests, publication: (name: string) => page.publications.find((item) => item.title === name)! };
}

describe('OPDS native redirects over real loopback HTTP', () => {
  it('follows catalog and cross-origin EPUB redirects for lazy reading and bound full downloads', async () => {
    const { files, provider, connection, publication, requests } = await setup();
    const opened = await openRemotePublication(connection.id, publication('book').id);
    if (opened.kind !== 'opened') throw Error('Expected lazy EPUB reading');
    cleanup.push(() => removeComic(opened.comicId));
    const { context, entry } = await entrySource(opened.entryId);
    expect(entry.acquisition?.kind).toBe('range-file');
    expect(entry.containerId).toBeUndefined();
    expect(requests.slice(0, 2)).toEqual(['/opds', '/catalog/feed.json']);
    expect(requests).toContain('/catalog/book.epub');
    expect(files.requests[0]).toMatchObject({ path: '/book.epub', range: 'bytes=0-0', status: 206 });
    const source = await openFileSource(context);
    cleanup.push(() => source.close());
    const archive = await openEpubArchive(source);
    cleanup.push(() => archive.close());
    expect(await archive.text('OPS/one.xhtml')).toContain('Chapter One');
    const afterChapter = files.requests.length;
    await archive.text('OPS/one.xhtml');
    expect(files.requests).toHaveLength(afterChapter);
    expect(await archive.text('OPS/two.xhtml')).toContain('Chapter Two');
    expect(files.requests.every((request) => request.status === 206)).toBe(true);
    expect(files.requests.slice(1).every((request) => request.ifMatch === files.state.etag)).toBe(true);
    const transferred = files.requests.reduce((sum, request) => sum + request.bytes, 0);
    expect(transferred).toBeLessThan(files.bytes.length / 5);
    console.info(JSON.stringify({ fixture: 'opds-redirect', fileBytes: files.bytes.length, chapterBytes: transferred, fileRequests: files.requests.length }));

    const download = await provider.files!.download!(context);
    expect(Buffer.from(await new Response(download.stream).arrayBuffer()).equals(files.bytes)).toBe(true);
    expect(files.requests.at(-1)).toMatchObject({ status: 200, ifMatch: files.state.etag });
    files.state.etag = '"fixture-v2"';
    await expect(provider.files!.download!(context)).rejects.toMatchObject({ code: 'source-changed', details: { status: 412 } });
  });

  it('resolves search descriptions, publication details and external catalog links after redirects', async () => {
    const { files, provider, connection, page, publication, requests } = await setup();
    const searched = await browseRemoteLibrary(connection.id, { search: 'comic' });
    expect(searched.publications).toHaveLength(page.publications.length);
    expect(requests).toContain('/discovery/search.xml');
    expect(requests).toContain('/catalog/feed.json?q=comic');
    const detail = await provider.catalog!.resolve(connection, publication('detail').id);
    expect(detail.kind).toBe('range-file');
    expect(requests).toContain('/metadata/book.json');
    expect(requests).toContain('/catalog/book.epub');
    const external = await browseRemoteLibrary(connection.id, { location: page.navigation[0].location });
    const book = external.publications.find((item) => item.title === 'EPUB book')!;
    expect((await provider.catalog!.resolve(connection, book.id)).kind).toBe('range-file');
    expect(files.requests.at(-1)).toMatchObject({ path: '/book.epub', status: 206 });
  });

  it('keeps explicit download fallback when the redirect target ignores Range', async () => {
    const { files, connection, publication } = await setup();
    await expect(openRemotePublication(connection.id, publication('no-range').id)).resolves.toMatchObject({ kind: 'download-required' });
    expect(files.requests).toHaveLength(1);
    expect(files.requests[0]).toMatchObject({ range: 'bytes=0-0', status: 200 });
  });

  it.each([
    { name: 'denied', status: 403, code: 'access-denied' },
    { name: 'expired', status: 401, code: 'authentication-required' },
  ])('preserves final HTTP $status after a redirect without downloading or retrying', async ({ name, status, code }) => {
    const { files, connection, publication } = await setup();
    await expect(openRemotePublication(connection.id, publication(name).id)).rejects.toMatchObject({ code, details: { status } });
    expect(files.requests).toHaveLength(1);
    expect(files.requests[0]).toMatchObject({ range: 'bytes=0-0', status });
  });

  it('uses the native redirect-loop limit without requesting the file', async () => {
    const { files, connection, publication, requests } = await setup();
    await expect(openRemotePublication(connection.id, publication('loop').id)).rejects.toMatchObject({ code: 'network' });
    expect(files.requests).toHaveLength(0);
    const redirects = requests.filter((path) => path === '/catalog/loop.epub').length;
    expect(redirects).toBeGreaterThan(1);
    expect(redirects).toBeLessThanOrEqual(21);
  });
});
