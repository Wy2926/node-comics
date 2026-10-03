import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { PageDescriptor, SourceConnection } from '../src/comics/domain';
import type {
  OpenFileSourceContext,
  RemoteReadingPlan,
  SourceAccount,
} from '../src/comics/sources/contracts';
import { createOpdsProvider } from '../src/comics/sources/opds/provider';
import { PrivateOpdsStore, type PrivateConnection } from '../src/comics/sources/opds/private-store';
import {
  discoverProgressBinding,
  pseProgress,
  readOpdsProgress,
  writeOpdsProgress,
} from '../src/comics/sources/opds/progress';
import { OpdsTransport } from '../src/comics/sources/opds/transport';
import { jsonPublication, type OpdsLink } from '../src/comics/sources/opds/protocol';
import { installTestXmlParser } from './opds-protocol-dom';
import { OpdsError } from '../src/comics/sources/opds/errors';

installTestXmlParser();

const origin = 'https://catalog.example';
const root = origin + '/shelf/api/opds/example-key';
const connection: PrivateConnection = {
  id: 'connection',
  name: 'Test',
  root,
  auth: { kind: 'url-token' },
  revision: 1,
  namespace: 'opds1',
  createdAt: 1,
};
const template: OpdsLink = {
  href: root + '/image?libraryId=1&seriesId=2&volumeId=3&chapterId=4&pageNumber={pageNumber}',
  type: 'image/jpeg',
  rels: ['http://vaemendis.net/opds-pse/stream'],
  count: 5,
  indirect: false,
};
const publication = { title: 'Book', links: [template], images: [], authors: [] };
const opening = { format: 'image-sequence' as const, template };
const publicConnection = (account: SourceAccount): SourceConnection => ({
  ...account,
  generation: 1,
  createdAt: 1,
  updatedAt: 1,
});
function context(account: SourceAccount, plan: RemoteReadingPlan): OpenFileSourceContext {
  return {
    connection: publicConnection(account),
    source: {
      connectionId: account.id,
      providerItemId: plan.publication.id,
      locator: plan.locator,
      generation: 1,
      status: 'active',
    },
    entryId: 'entry',
    contentId: 'content',
    format: plan.format,
    sourceSnapshot: plan.snapshot,
  };
}
const descriptor = (page: {
  ordinal: number;
  name: string;
  locator: Record<string, unknown>;
}): PageDescriptor => ({ ...page, pageId: 'page', contentId: 'content', formatLocator: 'opds' });

async function kavitaScenario(progressResponse: () => Response | Promise<Response>, lastRead = 3) {
  const requests: Request[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (request.url === root)
      return new Response(
        `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:pse="http://vaemendis.net/opds-pse/ns"><title>Catalog</title><entry><id>book:4</id><title>Book</title><link href="${template.href.replaceAll('&', '&amp;')}" rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" pse:count="5" pse:lastRead="${lastRead}"/></entry></feed>`,
      );
    if (url.pathname === '/shelf/api/Reader/get-progress') return progressResponse();
    if (url.pathname.endsWith('/image'))
      return new Response(new Uint8Array([255, 216, 255, 217]), {
        headers: { 'Content-Type': 'image/jpeg' },
      });
    if (url.pathname === '/shelf/api/Reader/progress' && request.method === 'POST')
      return new Response(null, { status: 204 });
    throw new Error('unexpected route');
  });
  const databaseName = 'opds-progress-fallback-' + crypto.randomUUID();
  const store = new PrivateOpdsStore(databaseName);
  const provider = createOpdsProvider({ store, fetch: fetcher });
  const account = await provider.connection!.connect!({
    name: 'Test',
    url: root,
    auth: 'url-token',
  });
  const catalog = await provider.catalog!.browse({ connection: publicConnection(account) });
  const plan = await provider.catalog!.resolve(
    publicConnection(account),
    catalog.publications[0].id,
  );
  const ctx = context(account, plan);
  const index = await provider.pages!.index(ctx);
  return { provider, account, ctx, index, requests, fetcher, store, databaseName };
}

describe('OPDS reading progress profiles', () => {
  it.each([undefined, 'not a date', '2026-01-01T00:00:00Z'])(
    'marks generic catalog progress as a snapshot for date %s',
    (lastReadDate) => {
      const value = pseProgress({
        ...opening,
        template: {...template, lastRead: 3, lastReadDate},
      });
      expect(value).toEqual({
        pageIndex: 2,
        snapshot: true,
        ...(lastReadDate === '2026-01-01T00:00:00Z'
          ? {updatedAt: Date.parse(lastReadDate)}
          : {}),
      });
    },
  );

  it.each([
    template.href.replace('example-key', 'unrelated-key'),
    template.href.replace('/shelf/', '/other/'),
    template.href.replace('catalog.example', 'external.example'),
    template.href.replace('chapterId=4', 'chapterId=bad'),
    template.href.replace('chapterId=4', 'chapterId=4&chapterId=5'),
    template.href.replace('pageNumber={pageNumber}', 'pageNumber=0'),
  ])('does not derive an API profile from an unbound or malformed template', (href) => {
    expect(
      discoverProgressBinding(connection, publication, {
        ...opening,
        template: { ...template, href },
      }),
    ).toBeNull();
  });

  it('keeps image reads independent from progress and only writes explicit reading positions', async () => {
    let pageNum = 2;
    const requests: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (/\/api\/opds\/[^/]+$/.test(url.pathname)) {
        const href =
          request.url +
          '/image?libraryId=1&seriesId=2&volumeId=3&chapterId=4&pageNumber={pageNumber}';
        return new Response(
          `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:pse="http://vaemendis.net/opds-pse/ns"><title>Catalog</title><entry><id>book:4</id><title>Book</title><link href="${href.replaceAll('&', '&amp;')}" rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" pse:count="5" pse:lastRead="${pageNum}"/></entry></feed>`,
          { headers: { 'Content-Type': 'application/atom+xml' } },
        );
      }
      if (url.pathname === '/shelf/api/Reader/get-progress')
        return Response.json({
          chapterId: 4,
          volumeId: 3,
          seriesId: 2,
          libraryId: 1,
          pageNum,
          lastModifiedUtc: '2026-01-01T00:00:00Z',
        });
      if (url.pathname === '/shelf/api/Reader/image') {
        expect(request.method).toBe('GET');
        expect(url.searchParams.get('extractPdf')).toBe('true');
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      }
      if (url.pathname === '/shelf/api/Reader/progress') {
        expect(request.method).toBe('POST');
        const payload = await request.json();
        expect(payload).toEqual({
          chapterId: 4,
          volumeId: 3,
          seriesId: 2,
          libraryId: 1,
          pageNum: 1,
        });
        pageNum = payload.pageNum;
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected route');
    });
    const name = 'opds-progress-' + crypto.randomUUID();
    const provider = createOpdsProvider({ store: new PrivateOpdsStore(name), fetch: fetcher });
    const values = { name: 'Test', url: root, auth: 'url-token' };
    const account = await provider.connection!.connect!(values);
    const catalog = await provider.catalog!.browse({ connection: publicConnection(account) });
    const plan = await provider.catalog!.resolve(
      publicConnection(account),
      catalog.publications[0].id,
    );
    const ctx = context(account, plan);
    const beforeIndex = requests.length;
    const index = await provider.pages!.index(ctx);
    expect(requests).toHaveLength(beforeIndex);
    const progress = await provider.progress!.read(ctx);
    expect(progress).toMatchObject({ pageIndex: 2 });
    expect(progress).not.toHaveProperty('snapshot');
    await provider.pages!.read(ctx, descriptor(index.pages[0]));
    await provider.pages!.read(ctx, descriptor(index.pages[4]));
    expect(pageNum).toBe(2);
    expect(requests.filter((request) => request.url.includes('/get-progress'))).toHaveLength(1);
    expect(requests.every((request) => !request.headers.has('User-Agent'))).toBe(true);
    await provider.progress!.write(ctx, { pageIndex: 1 });
    expect(await provider.progress!.read(ctx)).toMatchObject({ pageIndex: 1 });
    await provider.connection!.disconnect!(account);
    const beforeRevokedWrite = requests.length;
    await expect(provider.progress!.write(ctx, { pageIndex: 1 })).rejects.toMatchObject({
      code: 'disconnected',
    });
    expect(requests).toHaveLength(beforeRevokedWrite);
    await provider.connection!.connect!(
      { ...values, url: root.replace('example-key', 'new-key') },
      account,
    );
    const reloaded = createOpdsProvider({ store: new PrivateOpdsStore(name), fetch: fetcher });
    await reloaded.pages!.read(ctx, descriptor(index.pages[1]));
    expect(new URL(requests.at(-1)!.url).searchParams.get('apiKey')).toBe('new-key');
    expect(pageNum).toBe(1);
  });

  it('rejects mismatched progress ownership before permitting side-effect-free image substitution', async () => {
    const binding = discoverProgressBinding(connection, publication, opening)!;
    const transport = new OpdsTransport(async () =>
      Response.json({ chapterId: 99, pageNum: 1, volumeId: 3, seriesId: 2, libraryId: 1 }),
    );
    await expect(readOpdsProgress(transport, connection, binding, opening)).rejects.toMatchObject({
      code: 'invalid-catalog',
    });
    await expect(
      writeOpdsProgress(transport, connection, binding, opening, { pageIndex: 1 }),
    ).rejects.toMatchObject({ code: 'invalid-catalog' });
  });

  it.each([403, 404, 500, 'invalid-json', 'bad-profile', 'unsupported'] as const)(
    'keeps advertised PSE readable when the optional API returns %s without retrying per page or writing unverified APIs',
    async (failure) => {
      const scenario = await kavitaScenario(() => {
        if (typeof failure === 'number') return new Response(null, { status: failure });
        if (failure === 'invalid-json') return new Response('not json');
        if (failure === 'unsupported') throw new OpdsError('unsupported', 'not supported');
        return Response.json({ chapterId: 99, volumeId: 3, seriesId: 2, libraryId: 1, pageNum: 1 });
      });
      const { provider, account, ctx, index, requests, fetcher, store, databaseName } = scenario;

      expect(await provider.progress!.read(ctx)).toEqual({ pageIndex: 3, snapshot: true });
      await provider.pages!.read(ctx, descriptor(index.pages[0]));
      await provider.pages!.read(ctx, descriptor(index.pages[1]));
      await provider.progress!.write(ctx, { pageIndex: 2 });
      const reloaded = createOpdsProvider({
        store: new PrivateOpdsStore(databaseName),
        fetch: fetcher,
      });
      await reloaded.pages!.read(ctx, descriptor(index.pages[2]));

      expect(requests.filter((request) => request.url.includes('/get-progress'))).toHaveLength(1);
      expect(
        requests.filter(
          (request) =>
            new URL(request.url).pathname.includes('/api/opds/') &&
            new URL(request.url).pathname.endsWith('/image'),
        ),
      ).toHaveLength(3);
      expect(
        requests.some((request) => new URL(request.url).pathname === '/shelf/api/Reader/image'),
      ).toBe(false);
      expect(requests.every((request) => request.method === 'GET')).toBe(true);
      expect((await store.connection(account.id))?.disconnected).not.toBe(true);
      expect((await provider.connection!.list!())[0].status).toBe('connected');
    },
  );

  it('remembers a failed page-driven verification and retries only on an explicit progress read', async () => {
    let available = false;
    const { provider, ctx, index, requests } = await kavitaScenario(() =>
      available
        ? Response.json({ chapterId: 4, volumeId: 3, seriesId: 2, libraryId: 1, pageNum: 2 })
        : new Response(null, { status: 404 }),
    );
    await provider.pages!.read(ctx, descriptor(index.pages[0]));
    await provider.pages!.read(ctx, descriptor(index.pages[1]));
    await provider.progress!.write(ctx, { pageIndex: 1 });
    expect(requests.filter((request) => request.url.includes('/get-progress'))).toHaveLength(1);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);

    available = true;
    expect(await provider.progress!.read(ctx)).toMatchObject({ pageIndex: 2 });
    await provider.pages!.read(ctx, descriptor(index.pages[2]));
    expect(new URL(requests.at(-1)!.url).pathname).toBe('/shelf/api/Reader/image');
    await provider.progress!.write(ctx, { pageIndex: 1 });
    expect(requests.at(-1)!.method).toBe('POST');
    expect(requests.filter((request) => request.url.includes('/get-progress'))).toHaveLength(2);
  });

  it.each([
    { lastRead: 0, pageIndex: 0 },
    { lastRead: 5, pageIndex: 4 },
    { lastRead: 6, pageIndex: undefined },
    { lastRead: -1, pageIndex: undefined },
  ])(
    'bounds the zero-based Kavita lastRead fallback at $lastRead',
    async ({ lastRead, pageIndex }) => {
      const { provider, ctx } = await kavitaScenario(
        () => new Response(null, { status: 404 }),
        lastRead,
      );
      expect(await provider.progress!.read(ctx)).toEqual(
        pageIndex === undefined ? null : { pageIndex, snapshot: true },
      );
    },
  );

  it.each([401, 'source-changed', 'scope-blocked', 'disconnected', 'rate-limit'] as const)(
    'does not fall back from identity or access failure %s',
    async (failure) => {
      const { provider, ctx, index, requests } = await kavitaScenario(() => {
        if (typeof failure === 'number') return new Response(null, { status: failure });
        throw new OpdsError(failure, 'access rejected');
      });
      await expect(provider.pages!.read(ctx, descriptor(index.pages[0]))).rejects.toMatchObject({
        code: failure === 401 ? 'authentication-required' : failure,
      });
      expect(requests.some((request) => new URL(request.url).pathname.endsWith('/image'))).toBe(
        false,
      );
    },
  );

  it('does not turn a cancelled verification into a PSE request', async () => {
    const controller = new AbortController();
    const { provider, ctx, index, requests } = await kavitaScenario(() => {
      controller.abort();
      return new Response(null, { status: 404 });
    });
    await expect(
      provider.pages!.read({ ...ctx, signal: controller.signal }, descriptor(index.pages[0])),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests.some((request) => new URL(request.url).pathname.endsWith('/image'))).toBe(
      false,
    );
  });

  it('does not fall back after the connection is revoked during optional endpoint verification', async () => {
    let disconnect = async () => {};
    const { provider, account, ctx, index, requests } = await kavitaScenario(async () => {
      await disconnect();
      return new Response(null, { status: 403 });
    });
    disconnect = () => provider.connection!.disconnect!(account);
    await expect(provider.pages!.read(ctx, descriptor(index.pages[0]))).rejects.toMatchObject({
      code: 'disconnected',
    });
    expect(requests.some((request) => new URL(request.url).pathname.endsWith('/image'))).toBe(
      false,
    );
  });

  it.each([
    { lastRead: undefined, pageIndex: undefined },
    { lastRead: 0, pageIndex: undefined },
    { lastRead: 1, pageIndex: 0 },
    { lastRead: 4, pageIndex: 3 },
    { lastRead: 5, pageIndex: 4 },
    { lastRead: 6, pageIndex: undefined },
  ])(
    'reads fresh standard PSE lastRead=$lastRead without inventing an API',
    async ({ lastRead, pageIndex }) => {
      const feed = (value?: number) =>
        `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:pse="http://vaemendis.net/opds-pse/ns"><title>Catalog</title><entry><id>book:4</id><title>Book</title><link href="/book/4/{pageNumber}.jpg" rel="http://vaemendis.net/opds-pse/stream" type="image/jpeg" pse:count="5" ${value === undefined ? '' : `pse:lastRead="${value}" pse:lastReadDate="2026-01-01T00:00:00Z"`}/></entry></feed>`;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(feed(1)))
        .mockResolvedValueOnce(new Response(feed(lastRead)));
      const provider = createOpdsProvider({
        store: new PrivateOpdsStore('opds-standard-progress-' + crypto.randomUUID()),
        fetch: fetcher,
      });
      const account = await provider.connection!.connect!({
        name: 'Standard PSE',
        url: origin + '/pse',
        auth: 'anonymous',
      });
      const catalog = await provider.catalog!.browse({ connection: publicConnection(account) });
      const plan = await provider.catalog!.resolve(
        publicConnection(account),
        catalog.publications[0].id,
      );
      const ctx = context(account, plan);

      expect(await provider.progress!.read(ctx)).toEqual(
        pageIndex === undefined
          ? null
          : { pageIndex, snapshot: true, updatedAt: Date.parse('2026-01-01T00:00:00Z') },
      );
      await provider.progress!.write(ctx, { pageIndex: 2 });

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        fetcher.mock.calls.every(
          ([url, options]) => url === origin + '/pse' && options?.method === 'GET',
        ),
      ).toBe(true);
    },
  );

  it('round-trips advertised Readium EPUB locators with a precise PUT target', async () => {
    const book = jsonPublication(
      {
        metadata: { title: 'EPUB' },
        links: [
          {
            rel: 'http://www.cantook.com/api/progression',
            type: 'application/vnd.readium.progression+json',
            href: '/custom/book/progression',
          },
        ],
      },
      origin,
    );
    const binding = discoverProgressBinding(
      { ...connection, root: origin + '/opds', auth: { kind: 'anonymous' } },
      book,
      { format: 'epub' },
    )!;
    let written: unknown;
    const transport = new OpdsTransport(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(origin + '/custom/book/progression');
      if (request.method === 'GET')
        return Response.json({
          modified: '2026-01-01T00:00:00Z',
          locator: {
            href: 'OEBPS/chapter.xhtml',
            type: 'application/xhtml+xml',
            locations: { progression: 0.25, fragments: ['epubcfi(/6/4!/4/2/1:0)'] },
          },
        });
      expect(request.method).toBe('PUT');
      written = await request.json();
      return new Response(null, { status: 204 });
    });
    const progress = await readOpdsProgress(transport, connection, binding, { format: 'epub' });
    expect(progress).toEqual({
      documentLocation: {
        href: 'OEBPS/chapter.xhtml',
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        progression: 0.25,
      },
      updatedAt: Date.parse('2026-01-01T00:00:00Z'),
    });
    await writeOpdsProgress(
      transport,
      connection,
      binding,
      { format: 'epub' },
      { ...progress!, updatedAt: Date.parse('2026-01-01T00:00:01Z') },
    );
    expect(written).toMatchObject({
      modified: '2026-01-01T00:00:01.000Z',
      locator: {
        href: 'OEBPS/chapter.xhtml',
        locations: { progression: 0.25, fragments: ['epubcfi(/6/4!/4/2/1:0)'] },
      },
    });
  });

  it('does not invent progression endpoints, expose private locator URLs, or turn 204 into an empty read position', async () => {
    const book = jsonPublication(
      {
        metadata: { title: 'Book' },
        links: [
          {
            rel: 'self',
            type: 'application/vnd.readium.progression+json',
            href: '/not-advertised',
          },
        ],
      },
      origin,
    );
    expect(discoverProgressBinding(connection, book, { format: 'epub' })).toBeNull();
    const binding = { kind: 'readium' as const, url: origin + '/progress' };
    expect(
      await readOpdsProgress(
        new OpdsTransport(async () => new Response(null, { status: 204 })),
        connection,
        binding,
        { format: 'epub' },
      ),
    ).toBeUndefined();
    const privateUrl = origin + '/resource?token=private';
    expect(
      await readOpdsProgress(
        new OpdsTransport(async () =>
          Response.json({ locator: { href: privateUrl, locations: { progression: 0.5 } } }),
        ),
        connection,
        binding,
        { format: 'epub' },
      ),
    ).toBeUndefined();
    await expect(
      writeOpdsProgress(
        new OpdsTransport(vi.fn()),
        connection,
        binding,
        { format: 'epub' },
        { documentLocation: { href: privateUrl, progression: 0.5 } },
      ),
    ).rejects.toMatchObject({ code: 'invalid-catalog' });
  });

  it('converts one-based Readium image positions to zero-based page indices', async () => {
    const binding = { kind: 'readium' as const, url: origin + '/progress' };
    const pages = [template, template, template];
    let payload: unknown;
    const transport = new OpdsTransport(async (_url, options) => {
      if (options?.method === 'PUT') {
        payload = JSON.parse(String(options.body));
        return new Response(null, { status: 204 });
      }
      return Response.json({ locator: { href: '', locations: { position: 2 } } });
    });
    expect(
      await readOpdsProgress(transport, connection, binding, { format: 'image-sequence', pages }),
    ).toMatchObject({ pageIndex: 1 });
    await writeOpdsProgress(
      transport,
      connection,
      binding,
      { format: 'image-sequence', pages },
      { pageIndex: 2 },
    );
    expect(payload).toMatchObject({ locator: { locations: { position: 3 } } });
  });
});

describe.skipIf(process.env.OPDS_LIVE_PROGRESS !== '1')(
  'official Komga progression (real network)',
  () => {
    it('round-trips the advertised EPUB locator without downloading the book or guessing API routes', async () => {
      const nativeFetch = globalThis.fetch.bind(globalThis);
      let writes = 0;
      let reads = 0;
      const advertised = new Set<string>();
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== 'https://demo.komga.org') throw new Error('external-request-blocked');
        if (request.method === 'PUT') {
          if (!advertised.has(request.url) || writes >= 2)
            throw new Error('unadvertised-progression-write-blocked');
          writes++;
        } else if (
          request.method === 'GET' &&
          !/\/(?:file|resource|pages)(?:\/|$)/.test(url.pathname)
        )
          reads++;
        else throw new Error('unnecessary-content-request-blocked');
        const response = await nativeFetch(request);
        if (
          response.ok &&
          response.headers.get('Content-Type')?.includes('json') &&
          !url.pathname.endsWith('/progression')
        ) {
          const body = (await response.clone().json()) as {
            links?: { rel?: string; type?: string; href?: string }[];
          };
          for (const link of body.links ?? []) {
            if (
              link.rel === 'http://www.cantook.com/api/progression' &&
              link.type === 'application/vnd.readium.progression+json' &&
              link.href
            )
              advertised.add(new URL(link.href, request.url).href);
          }
        }
        return response;
      };
      const databaseName = 'opds-live-progression-' + crypto.randomUUID();
      const provider = createOpdsProvider({
        store: new PrivateOpdsStore(databaseName),
        fetch: fetcher,
      });
      let account: SourceAccount | undefined;
      try {
        account = await provider.connection!.connect!({
          name: 'Official Komga demo',
          url: 'https://demo.komga.org/opds/v2/catalog',
          auth: 'basic',
          username: 'demo@komga.org',
          password: 'komga-demo',
        });
        let catalog = await provider.catalog!.browse({ connection: publicConnection(account) });
        const publications = () => [
          ...catalog.publications,
          ...(catalog.groups ?? []).flatMap((group) => group.publications),
        ];
        let book = publications().find((book) => book.title.startsWith('Moby Dick'));
        if (!book) {
          catalog = await provider.catalog!.browse({
            connection: publicConnection(account),
            search: 'Moby Dick',
          });
          book = publications().find((book) => book.title.startsWith('Moby Dick'));
        }
        if (!book) throw new Error('public-epub-sample-not-in-catalog');
        const plan = await provider.catalog!.resolve(publicConnection(account), book.id);
        if (plan.format !== 'epub') throw new Error('sample-is-not-epub');
        const ctx = context(account, plan);
        const original = await provider.progress!.read(ctx);
        if (
          !original?.documentLocation?.href ||
          original.documentLocation.progression === undefined
        )
          throw new Error('no-existing-locator-to-safely-restore');
        // Re-save the existing internal locator: the server validates resource/progression correspondence.
        await provider.progress!.write(ctx, {
          documentLocation: original.documentLocation,
          updatedAt: Date.now(),
        });
        const reloaded = createOpdsProvider({
          store: new PrivateOpdsStore(databaseName),
          fetch: fetcher,
        });
        const restored = await reloaded.progress!.read(ctx);
        if (
          restored?.documentLocation?.href !== original.documentLocation.href ||
          restored.documentLocation.progression !== original.documentLocation.progression ||
          restored.documentLocation.cfi !== original.documentLocation.cfi
        )
          throw new Error('server-locator-roundtrip-mismatch');
        process.stdout.write(
          JSON.stringify({
            service: 'official-komga-demo',
            check: 'epub-reading-progress-roundtrip',
            passed: true,
            readRequests: reads,
            writeRequests: writes,
            existingLocatorPreserved: true,
            hasCfi: !!restored.documentLocation.cfi,
            progression: restored.documentLocation.progression,
          }) + '\n',
        );
      } catch (error) {
        // Never expose response bodies, private locators, addresses, authorization or native causes.
        const code = error instanceof OpdsError ? error.code : 'live-validation-failed';
        const status = error instanceof OpdsError ? error.details.status : undefined;
        process.stdout.write(
          JSON.stringify({
            service: 'official-komga-demo',
            passed: false,
            code,
            status,
            reads,
            writes,
          }) + '\n',
        );
        throw new Error(`Komga progression live failed: ${code}${status ? ' HTTP ' + status : ''}`);
      } finally {
        if (account) await provider.connection!.disconnect!(account);
      }
    }, 60000);
  },
);
