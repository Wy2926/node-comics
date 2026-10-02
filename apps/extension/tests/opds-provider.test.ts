import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createOpdsProvider } from '../src/comics/sources/opds/provider';
import { PrivateOpdsStore, type PrivateConnection } from '../src/comics/sources/opds/private-store';
import { allowedUrl, OpdsTransport, readBounded } from '../src/comics/sources/opds/transport';
import type { SourceConnection, PageDescriptor } from '../src/comics/domain';
import type {
  OpenFileSourceContext,
  RemoteReadingPlan,
  SourceAccount,
} from '../src/comics/sources/contracts';
import { installTestXmlParser } from './opds-protocol-dom';

installTestXmlParser();

const ROOT = 'https://catalog.example/opds';
const publication = {
  metadata: { title: 'Book', identifier: 'urn:isbn:shared' },
  links: [{ href: '/book/1/manifest', rel: 'self', type: 'application/divina+json' }],
  images: [{ href: '/cover.jpg', type: 'image/jpeg' }],
};
const catalog = {
  metadata: { title: 'Library' },
  links: [
    { href: ROOT, rel: 'self' },
    { href: '/search{?query}', rel: 'search', type: 'application/opds+json' },
  ],
  publications: [publication],
  navigation: [{ href: '/next', title: 'Next' }],
};
const manifest = {
  metadata: { title: 'Book', modified: '2026-01-01' },
  links: [{ href: '/book/1/manifest', rel: 'self' }],
  readingOrder: [
    { href: '/pages/1.jpg', type: 'image/jpeg', width: 1200, height: 1800 },
    { href: '/pages/2.jpg', type: 'image/jpeg' },
  ],
};
const publicConnection = (a: SourceAccount): SourceConnection => ({
  ...a,
  generation: 1,
  createdAt: 1,
  updatedAt: 1,
});
function context(a: SourceAccount, plan: RemoteReadingPlan): OpenFileSourceContext {
  return {
    connection: publicConnection(a),
    source: {
      connectionId: a.id,
      providerItemId: plan.publication.id,
      locator: plan.locator,
      generation: 1,
      status: 'active',
    },
    entryId: 'entry',
    contentId: 'content',
    sourceSnapshot: plan.snapshot,
    format: plan.format,
  };
}
const values = {
  name: 'Private',
  url: ROOT,
  auth: 'basic',
  username: 'person',
  password: 'password-private',
};
function setup(responses: Response[] = []) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw Error('unexpected request');
    return response;
  });
  const name = `opds-test-${crypto.randomUUID()}`,
    store = new PrivateOpdsStore(name),
    provider = createOpdsProvider({ store, fetch: fetcher });
  return { provider, store, fetcher, name };
}
function pageDescriptor(page: {
  ordinal: number;
  name: string;
  locator: Record<string, unknown>;
}): PageDescriptor {
  return {
    ...page,
    pageId: 'page',
    contentId: 'content',
    formatLocator: 'opds',
  };
}
describe('OPDS connection/provider', () => {
  it('browses without importing/fetching covers or pages and exposes no transport URL or credentials', async () => {
    const { provider, fetcher } = setup([Response.json(catalog), Response.json(catalog)]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(page.publications).toHaveLength(1);
    expect(page.searchable).toBe(true);
    const publicState = JSON.stringify({ a, page });
    expect(publicState).not.toContain('password-private');
    expect(publicState).not.toContain('/book/1/manifest');
    expect(publicState).not.toContain('/cover.jpg');
    expect(
      fetcher.mock.calls.every(
        ([, init]) =>
          init?.redirect === 'error' &&
          init?.credentials === 'omit' &&
          init?.referrerPolicy === 'no-referrer',
      ),
    ).toBe(true);
  });
  it('resolves image-only manifest and reads originals through opaque descriptors', async () => {
    const { provider } = setup([
        Response.json(catalog),
        Response.json(catalog),
        Response.json(manifest),
        new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      }),
      plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id),
      ctx = context(a, plan),
      index = await provider.pages!.index(ctx);
    expect(plan.kind).toBe('pages');
    expect(index.total).toBe(2);
    expect(index.pages[0].locator).not.toHaveProperty('url');
    expect(JSON.stringify(plan)).not.toContain('/pages/');
    expect(
      await (await provider.pages!.read(ctx, pageDescriptor(index.pages[0]))).arrayBuffer(),
    ).toEqual(new Uint8Array([255, 216, 255, 217]).buffer);
  });
  it('retains selected locators after provider reload, credential rotation and disconnect/reconnect', async () => {
    const { provider, store, fetcher, name } = setup([
        Response.json(catalog),
        Response.json(catalog),
        Response.json(manifest),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      }),
      plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id),
      ctx = context(a, plan);
    const revoked = vi.fn(async () => {});
    provider.subscribe!(revoked);
    fetcher.mockImplementation(async (url) =>
      String(url).endsWith('.jpg')
        ? new Response(new Uint8Array([255, 216]), {
            headers: { 'Content-Type': 'image/jpeg' },
          })
        : Response.json({ ...catalog, publications: [] }),
    );
    const same = await provider.connection!.connect!({ ...values, password: 'rotated-private' }, a);
    expect(same.id).toBe(a.id);
    expect(revoked).not.toHaveBeenCalled();
    expect((await provider.pages!.index(ctx)).total).toBe(2);
    await provider.connection!.disconnect!(same);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await store.connection(a.id))).not.toMatch(
      /password-private|rotated-private/,
    );
    await expect(provider.pages!.index(ctx)).rejects.toMatchObject({
      code: 'disconnected',
    });
    await provider.connection!.connect!({ ...values, password: 'third' }, same);
    const reloaded = createOpdsProvider({
      store: new PrivateOpdsStore(name),
      fetch: fetcher,
    });
    const index = await reloaded.pages!.index(ctx);
    expect(index.total).toBe(2);
    expect((await reloaded.pages!.read(ctx, pageDescriptor(index.pages[0]))).size).toBe(2);
  });
  it('rebinds known URL-token positions without exposing or retaining the disconnected secret', async () => {
    const tokenCatalog = {
        metadata: { title: 'Private' },
        publications: [
          {
            metadata: { title: 'Book' },
            links: [
              {
                rel: 'self',
                href: '/manifest?token=old-secret',
                type: 'application/divina+json',
              },
            ],
          },
        ],
      },
      tokenManifest = {
        metadata: { title: 'Book' },
        readingOrder: [{ href: '/page.jpg?token=old-secret', type: 'image/jpeg' }],
      };
    const { provider, store, fetcher } = setup([
        Response.json(tokenCatalog),
        Response.json(tokenCatalog),
        Response.json(tokenManifest),
      ]),
      input = {
        name: 'Token',
        url: ROOT + '?token=old-secret',
        auth: 'url-token',
      },
      a = await provider.connection!.connect!(input),
      catalogPage = await provider.catalog!.browse({
        connection: publicConnection(a),
      }),
      plan = await provider.catalog!.resolve(publicConnection(a), catalogPage.publications[0].id),
      ctx = context(a, plan);
    expect(JSON.stringify({ a, plan, catalogPage })).not.toContain('old-secret');
    await provider.connection!.disconnect!(a);
    expect(JSON.stringify(await store.resource(plan.representationId))).not.toContain('old-secret');
    fetcher
      .mockResolvedValueOnce(Response.json({ ...tokenCatalog, publications: [] }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([255, 216]), {
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      );
    const same = await provider.connection!.connect!(
        { ...input, url: ROOT + '?token=new-secret' },
        a,
      ),
      index = await provider.pages!.index(ctx);
    expect(same.id).toBe(a.id);
    await provider.pages!.read(ctx, pageDescriptor(index.pages[0]));
    expect(fetcher.mock.lastCall?.[0]).toBe('https://catalog.example/page.jpg?token=new-secret');
  });
  it('keeps v1/v2 namespaces and different Basic accounts isolated', async () => {
    const { provider } = setup([Response.json(catalog)]),
      a = await provider.connection!.connect!(values);
    await expect(
      provider.connection!.connect!({ ...values, username: 'other' }, a),
    ).rejects.toMatchObject({ code: 'scope-blocked' });
    await expect(
      provider.connection!.connect!({ ...values, url: ROOT + '/v2' }, a),
    ).rejects.toMatchObject({ code: 'scope-blocked' });
  });
  it('does not restore credentials after another provider disconnects during a pending reconnect', async () => {
    const { provider, store, fetcher, name } = setup([Response.json(catalog)]),
      a = await provider.connection!.connect!(values);
    let resolveRequest!: (response: Response) => void, started!: () => void;
    const pending = new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
      requested = new Promise<void>((resolve) => {
        started = resolve;
      });
    fetcher.mockImplementation(async () => {
      started();
      return pending;
    });
    const reconnect = provider.connection!.connect!({ ...values, password: 'late-secret' }, a);
    await requested;
    const other = createOpdsProvider({
      store: new PrivateOpdsStore(name),
      fetch: fetcher,
    });
    await other.connection!.disconnect!(a);
    resolveRequest(Response.json(catalog));
    await expect(reconnect).rejects.toMatchObject({ code: 'disconnected' });
    const saved = await store.connection(a.id);
    expect(saved?.disconnected).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/late-secret|password-private/);
  });
  it('follows an opaque search cursor without re-expanding the original query', async () => {
    const first = {
        ...catalog,
        links: [
          { href: ROOT, rel: 'self' },
          { href: '/search?query=duck&page=2', rel: 'next' },
        ],
      },
      second = { metadata: { title: 'Page 2' }, publications: [] },
      { provider, fetcher } = setup([
        Response.json(catalog),
        Response.json(first),
        Response.json(second),
      ]),
      a = await provider.connection!.connect!(values),
      one = await provider.catalog!.browse({ connection: publicConnection(a) });
    const two = await provider.catalog!.browse({
      connection: publicConnection(a),
      cursor: one.next,
      search: 'duck',
    });
    expect(two.title).toBe('Page 2');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.lastCall?.[0]).toBe('https://catalog.example/search?query=duck&page=2');
  });
  it('pins only selected records and does not downgrade them when browsing again', async () => {
    const { provider, store, fetcher, name } = setup([
        Response.json(catalog),
        Response.json(catalog),
        Response.json(manifest),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      }),
      id = page.publications[0].id;
    const reload = new PrivateOpdsStore(name);
    expect(await reload.resource(id)).toBeUndefined();
    const plan = await provider.catalog!.resolve(publicConnection(a), id);
    expect((await reload.resource(id))?.pinned).toBe(true);
    fetcher.mockResolvedValue(Response.json(catalog));
    await provider.catalog!.browse({ connection: publicConnection(a) });
    expect((await reload.resource(id))?.pinned).toBe(true);
    expect((await store.resource(plan.representationId))?.pinned).toBe(true);
  });
  it('does not fetch EPUB body or license/indirect acquisition as a comic', async () => {
    const unsupported = {
      metadata: { title: 'Library' },
      publications: [
        {
          metadata: { title: 'EPUB' },
          links: [
            {
              href: '/book.epub',
              rel: 'acquisition',
              type: 'application/epub+zip',
            },
          ],
        },
      ],
    };
    const { provider, fetcher } = setup([Response.json(unsupported), Response.json(unsupported)]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    await expect(
      provider.catalog!.resolve(publicConnection(a), page.publications[0].id),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('resolves WebPub with an EPUB alternate before deciding whether the body is an image sequence', async () => {
    const feed = {
        metadata: { title: 'Books' },
        publications: [
          {
            metadata: { title: 'Book' },
            readingOrder: [],
            links: [
              {
                href: '/manifest',
                rel: 'self',
                type: 'application/webpub+json',
              },
              {
                href: '/book.epub',
                rel: 'acquisition',
                type: 'application/epub+zip',
              },
            ],
          },
        ],
      },
      { provider, fetcher } = setup([
        Response.json(feed),
        Response.json(feed),
        Response.json(manifest),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(page.publications[0].readable).toBeUndefined();
    expect(page.publications[0].reason).toBeUndefined();
    const plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    expect(plan.kind).toBe('pages');
    expect(plan.publication.readable).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('reports EPUB after a real-shaped XHTML WebPub manifest without fetching its body', async () => {
    const book = {
        metadata: { title: 'Moby Dick' },
        links: [
          { href: '/manifest', rel: 'self', type: 'application/webpub+json' },
          {
            href: '/book.epub',
            rel: 'acquisition',
            type: 'application/epub+zip',
          },
        ],
      },
      feed = { metadata: { title: 'Books' }, publications: [book] },
      full = {
        ...book,
        readingOrder: [{ href: '/chapter.xhtml', type: 'application/xhtml+xml' }],
      };
    const { provider, fetcher } = setup([
        Response.json(feed),
        Response.json(feed),
        Response.json(full),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    await expect(
      provider.catalog!.resolve(publicConnection(a), page.publications[0].id),
    ).rejects.toThrow('此条目仅提供 EPUB，暂不支持阅读。');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.lastCall?.[0]).toBe('https://catalog.example/manifest');
  });
  it('resolves an Atom partial entry with quoted MIME parameters and an EPUB alternative', async () => {
    const feed =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Books</title><entry><id>book:1</id><title>Book</title><link rel="alternate" type="application/atom+xml; TYPE=&quot;entry&quot;; profile=opds-catalog" href="/complete"/><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/book.epub"/></entry></feed>';
    const full =
      '<entry xmlns="http://www.w3.org/2005/Atom"><id>book:1</id><title>Book</title><link rel="http://opds-spec.org/acquisition" type="application/pdf" href="/book.pdf"/></entry>';
    const { provider, fetcher } = setup([
        new Response(feed),
        new Response(feed),
        new Response(full),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(page.publications[0].readable).toBeUndefined();
    const plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    expect(plan.format).toBe('pdf');
    expect(plan.publication.id).toBe(page.publications[0].id);
    expect(fetcher.mock.lastCall?.[0]).toBe('https://catalog.example/complete');
  });
  it('supports embedded image readingOrder and does not use covers as pages', async () => {
    const book = { ...manifest, links: [{ href: '/book/1', rel: 'self' }] },
      feed = { metadata: { title: 'Books' }, publications: [book] };
    const { provider, fetcher } = setup([
        Response.json(feed),
        Response.json(feed),
        Response.json(feed),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(page.publications[0].readable).toBe(true);
    const plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    expect((await provider.pages!.index(context(a, plan))).total).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    'application/vnd.rar',
    'application/rar',
    'application/x-cbr',
    'application/vnd.comicbook-rar',
  ])('accepts the declared RAR comic MIME %s without guessing from the URL', async (type) => {
    const feed = {
      metadata: { title: 'Books' },
      publications: [
        {
          metadata: { title: 'RAR comic' },
          links: [{ href: '/download/42', rel: 'download', type }],
        },
      ],
    };
    const { provider, fetcher } = setup([Response.json(feed), Response.json(feed)]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(page.publications[0]).toMatchObject({
      readable: true,
      formats: ['cbr'],
    });
    const plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    expect(plan.format).toBe('cbr');
    expect(plan.kind).toBe('download-file');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { rel: 'borrow', type: 'application/pdf' },
    { rel: 'buy', type: 'application/zip' },
    {
      rel: 'download',
      type: 'application/zip',
      properties: { indirectAcquisition: [{ type: 'application/pdf' }] },
    },
    {
      rel: 'download',
      type: 'application/zip',
      properties: { encrypted: { scheme: 'https://example.test/drm' } },
    },
  ])(
    'keeps acquisition workflows unavailable and never requests their body: $rel',
    async (link) => {
      const feed = {
        metadata: { title: 'Books' },
        publications: [
          {
            metadata: { title: 'Restricted' },
            links: [{ ...link, href: '/restricted' }],
          },
        ],
      };
      const { provider, fetcher } = setup([Response.json(feed), Response.json(feed)]),
        a = await provider.connection!.connect!(values),
        page = await provider.catalog!.browse({
          connection: publicConnection(a),
        });
      expect(page.publications[0]).toMatchObject({
        readable: false,
        reason: '此条目需要 DRM 解锁、借阅、购买或其他获取流程，暂不支持阅读。',
      });
      await expect(
        provider.catalog!.resolve(publicConnection(a), page.publications[0].id),
      ).rejects.toThrow(/DRM/);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it('keeps a Range representation identical when explicitly downloading the same file', async () => {
    const feed = {
      metadata: { title: 'Files' },
      publications: [
        {
          metadata: { title: 'CBZ' },
          links: [
            {
              rel: 'self',
              href: '/entry',
              type: 'application/opds-publication+json',
            },
            { rel: 'acquisition', href: '/file.cbz', type: 'application/zip' },
          ],
        },
      ],
    };
    const book = feed.publications[0],
      range = () =>
        new Response(new Uint8Array([80]), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-0/100', ETag: '"revision-1"' },
        });
    const { provider } = setup([
        Response.json(feed),
        Response.json(feed),
        Response.json(book),
        range(),
        Response.json(book),
        range(),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      }),
      read = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id),
      download = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id, {
        purpose: 'download',
      });
    expect(read.kind).toBe('range-file');
    expect(download.kind).toBe('download-file');
    expect(download.representationId).toBe(read.representationId);
    expect(download.snapshot).toEqual(read.snapshot);
    expect((await provider.files!.open(context(a, read))).snapshot.version).toBe('"revision-1"');
  });
  it('cancels an ignored Range immediately and returns an explicit download plan', async () => {
    const feed = {
        metadata: { title: 'Files' },
        publications: [
          {
            metadata: { title: 'CBZ' },
            links: [
              {
                rel: 'acquisition',
                href: '/file.cbz',
                type: 'application/zip',
              },
            ],
          },
        ],
      },
      cancel = vi.fn();
    const { provider } = setup([
        Response.json(feed),
        Response.json(feed),
        new Response(new ReadableStream({ cancel }), { status: 200 }),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      }),
      plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    expect(plan.kind).toBe('download-file');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
describe('OPDS transport security', () => {
  const connection: PrivateConnection = {
    id: 'connection',
    name: 'Private',
    root: ROOT,
    auth: { kind: 'basic', username: 'user', password: 'secret' },
    revision: 1,
    namespace: 'opds2',
    createdAt: 1,
  };
  it('blocks cross-origin, embedded credentials, scheme change and unexpanded templates before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>(),
      transport = new OpdsTransport(fetcher);
    for (const url of [
      'https://other.example/a',
      'http://catalog.example/a',
      'https://user:pass@catalog.example/a',
      'file:///secret',
      'https://catalog.example/{pageNumber}',
    ])
      await expect(transport.bytes(connection, url)).rejects.toMatchObject({
        code: 'scope-blocked',
      });
    expect(fetcher).not.toHaveBeenCalled();
    expect(allowedUrl(connection, ROOT + '/book')).toBe(ROOT + '/book');
  });
  it('redacts native network errors and reports unsupported 401 auth documents', async () => {
    const native = new OpdsTransport(
      vi.fn<typeof fetch>(async () => {
        throw Error('https://secret.example/?token=secret');
      }),
    );
    await expect(native.bytes(connection, ROOT)).rejects.not.toThrow(/token|secret\.example/);
    const unsupported = new OpdsTransport(
      vi.fn<typeof fetch>(async () =>
        Response.json(
          { authentication: [{ type: 'oauth' }] },
          {
            status: 401,
            headers: { 'Content-Type': 'application/opds-authentication+json' },
          },
        ),
      ),
    );
    await expect(unsupported.bytes(connection, ROOT)).rejects.toMatchObject({
      code: 'unsupported-auth',
    });
  });
  it('bounds catalog bodies including missing Content-Length', async () => {
    const cancel = vi.fn();
    await expect(
      readBounded(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(10));
            },
            cancel,
          }),
        ),
        4,
      ),
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('binds current credentials before and after each network read', async () => {
    let current = true;
    const transport = new OpdsTransport(
      vi.fn<typeof fetch>(async () => {
        current = false;
        return new Response('bytes');
      }),
      async () => {
        if (!current) throw Error('revoked');
      },
    );
    await expect(transport.bytes(connection, ROOT)).rejects.toMatchObject({
      code: 'network',
    });
  });
  it('propagates 401 and 429 Retry-After to the generic source/download classification', async () => {
    const responses = [
        new Response('', { status: 401 }),
        new Response('', { status: 429, headers: { 'Retry-After': '17' } }),
      ],
      transport = new OpdsTransport(vi.fn<typeof fetch>(async () => responses.shift()!));
    await expect(transport.bytes(connection, ROOT)).rejects.toMatchObject({
      code: 'authentication-required',
      details: { status: 401 },
    });
    await expect(transport.download(connection, ROOT)).rejects.toMatchObject({
      code: 'rate-limit',
      details: { status: 429, retryAfter: 17 },
    });
  });
  it('binds full downloads with If-Match and rejects changed or truncated bodies', async () => {
    const cancel = vi.fn(),
      responses = [
        new Response(new ReadableStream({ cancel }), {
          headers: { ETag: '"new"', 'Content-Length': '3' },
        }),
        new Response(new Uint8Array([1, 2]), {
          headers: { ETag: '"old"', 'Content-Length': '3' },
        }),
      ],
      fetcher = vi.fn<typeof fetch>(async () => responses.shift()!),
      transport = new OpdsTransport(fetcher);
    await expect(
      transport.download(connection, ROOT, undefined, {
        etag: '"old"',
        size: 3,
      }),
    ).rejects.toMatchObject({ code: 'source-changed' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('If-Match')).toBe('"old"');
    const file = await transport.download(connection, ROOT, undefined, {
      etag: '"old"',
      size: 3,
    });
    await expect(new Response(file.stream).arrayBuffer()).rejects.toMatchObject({
      code: 'source-changed',
    });
  });
});

// Opt-in real-service contract check: official Komga demo's publicly documented credentials.
// No simulated feed, writes, progression endpoints, uploads or paid resources are used.
describe.skipIf(process.env.OPDS_LIVE !== '1')('OPDS public Komga demo (real network)', () => {
  it('identifies the public Moby Dick EPUB from its manifest without fetching XHTML or EPUB content', async () => {
    const methods: string[] = [];
    const readingTypes: Record<string, number> = {};
    const request: typeof fetch = async (input, init) => {
      methods.push(init?.method ?? 'GET');
      const response = await globalThis.fetch(input, init);
      if (response.headers.get('Content-Type')?.includes('json')) {
        const body = (await response.clone().json()) as {
          readingOrder?: { type?: string }[];
        };
        for (const link of body.readingOrder ?? []) {
          const type = link.type ?? 'missing';
          readingTypes[type] = (readingTypes[type] ?? 0) + 1;
        }
      }
      return response;
    };
    const provider = createOpdsProvider({
      store: new PrivateOpdsStore(`opds-live-ebook-${crypto.randomUUID()}`),
      fetch: request,
    });
    const account = await provider.connection!.connect!({
      name: 'Official Komga demo',
      url: 'https://demo.komga.org/opds/v2/catalog',
      auth: 'basic',
      username: 'demo@komga.org',
      password: 'komga-demo',
    });
    const connection = publicConnection(account);
    const catalog = await provider.catalog!.browse({ connection });
    const book = [
      ...catalog.publications,
      ...(catalog.groups?.flatMap((group) => group.publications) ?? []),
    ].find((publication) => publication.title.startsWith('Moby Dick'));
    expect(book).toBeDefined();
    expect(book!.readable).toBeUndefined();
    await expect(provider.catalog!.resolve(connection, book!.id)).rejects.toThrow(
      '此条目仅提供 EPUB，暂不支持阅读。',
    );
    expect(Object.keys(readingTypes)).toEqual(['application/xhtml+xml']);
    expect(methods).toEqual(['GET', 'GET', 'GET']);
    console.info(
      JSON.stringify({
        service: 'official-komga-demo',
        title: book!.title,
        readingTypes,
        getRequests: methods.length,
        rejectedAsEpub: true,
      }),
    );
  }, 60000);
  it('reads OPDS2 Divina and OPDS1 PSE originals, survives provider reload and reconnect', async () => {
    for (const [protocol, url] of [
      ['opds2', 'https://demo.komga.org/opds/v2/catalog'],
      ['opds1', 'https://demo.komga.org/opds/v1.2/catalog'],
    ] as const) {
      const name = `opds-live-${crypto.randomUUID()}`,
        store = new PrivateOpdsStore(name),
        methods: string[] = [],
        request: typeof fetch = async (input, init) => {
          methods.push(init?.method ?? 'GET');
          return globalThis.fetch(input, init);
        },
        provider = createOpdsProvider({ store, fetch: request });
      const input = {
          name: 'Official Komga demo',
          url,
          auth: 'basic',
          username: 'demo@komga.org',
          password: 'komga-demo',
        },
        a = await provider.connection!.connect!(input),
        connection = publicConnection(a);
      let catalogPage = await provider.catalog!.browse({ connection });
      if (protocol === 'opds1') {
        const series = catalogPage.navigation.find((n) => n.title === 'All series')!;
        catalogPage = await provider.catalog!.browse({
          connection,
          location: series.location,
        });
        const duck = catalogPage.navigation.find((n) => n.title.includes('Super Duck'))!;
        catalogPage = await provider.catalog!.browse({
          connection,
          location: duck.location,
        });
      } else {
        // The public demo's shared Keep Reading shelf changes when other readers use it.
        // Follow the advertised series navigation instead of assuming a book stays on that shelf.
        const seriesLinks = () => [
          ...catalogPage.navigation,
          ...(catalogPage.groups?.flatMap((group) => group.navigation) ?? []),
        ];
        if (!seriesLinks().some((link) => link.title === 'Super Duck')) {
          catalogPage = await provider.catalog!.browse({
            connection,
            search: 'Super Duck',
          });
        }
        const duck = seriesLinks().find((link) => link.title === 'Super Duck');
        expect(duck).toBeDefined();
        catalogPage = await provider.catalog!.browse({
          connection,
          location: duck!.location,
        });
      }
      const pubs = [
          ...catalogPage.publications,
          ...(catalogPage.groups?.flatMap((g) => g.publications) ?? []),
        ],
        book = pubs.find((p) => p.title === 'Super Duck 001')!;
      expect(book).toBeDefined();
      const plan = await provider.catalog!.resolve(connection, book.id),
        ctx = context(a, plan),
        index = await provider.pages!.index(ctx),
        image = await provider.pages!.read(ctx, pageDescriptor(index.pages[0]));
      expect(index.total).toBeGreaterThan(1);
      expect(image.type).toBe('image/jpeg');
      expect(image.size).toBeGreaterThan(10000);
      expect(new Uint8Array(await image.slice(0, 3).arrayBuffer())).toEqual(
        new Uint8Array([255, 216, 255]),
      );
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await image.arrayBuffer())),
        (b) => b.toString(16).padStart(2, '0'),
      ).join('');
      await provider.connection!.disconnect!(a);
      await provider.connection!.connect!(input, a);
      const reloaded = createOpdsProvider({
          store: new PrivateOpdsStore(name),
          fetch: request,
        }),
        again = await reloaded.pages!.index(ctx);
      expect(again.total).toBe(index.total);
      const reread = await reloaded.pages!.read(ctx, pageDescriptor(again.pages[0]));
      expect(reread.size).toBe(image.size);
      expect(methods.every((method) => method === 'GET')).toBe(true);
      console.info(
        JSON.stringify({
          service: 'official-komga-demo',
          protocol,
          title: book.title,
          pages: index.total,
          originalBytes: image.size,
          sha256: digest,
          requests: methods.length,
          reconnect: true,
        }),
      );
    }
  }, 120000);
});
