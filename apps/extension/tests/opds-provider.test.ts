import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createOpdsProvider } from '../src/comics/sources/opds/provider';
import { PrivateOpdsStore, type PrivateConnection } from '../src/comics/sources/opds/private-store';
import { allowedUrl, OpdsTransport, readBounded } from '../src/comics/sources/opds/transport';
import type { OpdsProgressTarget } from '../src/comics/sources/opds/progress';
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
  it('prefills editable configuration without exposing authentication inputs', async () => {
    const { provider, store } = setup([Response.json(catalog)]);
    const a = await provider.connection!.connect!(values);
    expect(await provider.connection!.configuration!(a)).toEqual({
      name: values.name,
      url: ROOT,
      auth: 'basic',
      _revision: String((await store.connection(a.id))!.revision),
    });
    const fields = provider.connection!.fields!;
    expect(fields.find((field) => field.id === 'url')?.showWhen).toEqual({ field: 'auth', values: ['anonymous', 'basic'] });
    for (const id of ['username', 'password']) {
      expect(fields.find((field) => field.id === id)).toMatchObject({
        required: true,
        sensitive: true,
        showWhen: { field: 'auth', values: ['basic'] },
      });
    }
    expect(fields.find((field) => field.id === 'tokenUrl')).toMatchObject({
      type: 'password', required: true, sensitive: true,
      showWhen: { field: 'auth', values: ['url-token'] },
    });
  });
  it('retains blank Basic credentials and permits independent password replacement', async () => {
    const { provider, store, fetcher } = setup([
      Response.json(catalog), Response.json(catalog), Response.json(catalog), Response.json(catalog),
    ]);
    const a = await provider.connection!.connect!(values);
    const original = await provider.connection!.configuration!(a);
    await provider.connection!.connect!({ ...original, name: 'Renamed', username: '', password: '' }, a);
    expect((await store.connection(a.id))!.auth).toEqual({ kind: 'basic', username: values.username, password: values.password });
    const rotated = await provider.connection!.connect!({
      ...(await provider.connection!.configuration!(a)), username: '', password: 'new-password',
    }, a);
    await provider.connection!.connect!({
      ...(await provider.connection!.configuration!(rotated)), username: values.username, password: '',
    }, rotated);
    const saved = (await store.connection(a.id))!;
    expect(saved.name).toBe('Renamed');
    expect(saved.auth).toEqual({ kind: 'basic', username: values.username, password: 'new-password' });
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get('Authorization')).toBe(`Basic ${btoa(values.username + ':new-password')}`);
  });
  it('retains token URLs only privately when authentication input is blank', async () => {
    const { provider, store, fetcher } = setup([Response.json(catalog), Response.json(catalog)]);
    const tokenUrl = ROOT + '?token=private-token';
    const a = await provider.connection!.connect!({ name: 'Token', auth: 'url-token', tokenUrl });
    const configuration = await provider.connection!.configuration!(a);
    expect(configuration).toEqual({ name: 'Token', auth: 'url-token', _revision: '1' });
    expect(JSON.stringify({ configuration, a })).not.toContain('private-token');
    await provider.connection!.connect!({ ...configuration, name: 'Token renamed', tokenUrl: '' }, a);
    expect((await store.connection(a.id))!.root).toBe(tokenUrl);
    expect((await store.connection(a.id))!.configurationUrl).toBeUndefined();
    expect(fetcher.mock.lastCall?.[0]).toBe(tokenUrl);
  });
  it('does not prefill a known credential URL even when its stored authentication mode differs', async () => {
    const { provider } = setup([Response.json(catalog)]);
    const a = await provider.connection!.connect!({ ...values, url: ROOT + '?token=private-token' });
    expect(await provider.connection!.configuration!(a)).not.toHaveProperty('url');
  });
  it('preserves safe directory configuration after disconnect but requires erased credentials again', async () => {
    const { provider, store, fetcher } = setup([Response.json(catalog), Response.json(catalog)]);
    const a = await provider.connection!.connect!(values);
    await provider.connection!.disconnect!(a);
    const configuration = await provider.connection!.configuration!(a);
    expect(configuration).toEqual({ name: values.name, auth: 'basic', url: ROOT, _revision: '2' });
    for (const authentication of [{ username: '', password: '' }, { username: values.username, password: '' }, { username: '', password: 'new-password' }]) {
      await expect(provider.connection!.connect!({ ...configuration, ...authentication }, a)).rejects.toMatchObject({ code: 'authentication-required' });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    await provider.connection!.connect!({ ...configuration, username: values.username, password: 'new-password' }, a);
    expect((await store.connection(a.id))!.disconnected).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('requires token authorization after disconnect instead of retaining the cleared URL', async () => {
    const { provider, fetcher } = setup([Response.json(catalog), Response.json(catalog)]);
    const a = await provider.connection!.connect!({ name: 'Token', auth: 'url-token', tokenUrl: ROOT + '?token=secret' });
    await provider.connection!.disconnect!(a);
    const configuration = await provider.connection!.configuration!(a);
    await expect(provider.connection!.connect!({ ...configuration, tokenUrl: '' }, a)).rejects.toMatchObject({ code: 'authentication-required' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await provider.connection!.connect!({ ...configuration, tokenUrl: ROOT + '?token=replaced' }, a);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each<Record<string, string>>([
    { ...values, username: '' },
    { ...values, password: '' },
    { ...values, username: 'invalid:username' },
    { name: 'Token', auth: 'url-token', tokenUrl: '' },
  ])('rejects missing or invalid authentication for a new connection', async (input) => {
    const { provider, store, fetcher } = setup();
    await expect(provider.connection!.connect!(input)).rejects.toMatchObject({ code: 'authentication-required' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await store.connections()).toEqual([]);
  });
  it('rejects unknown authentication instead of silently making a new anonymous connection', async () => {
    const { provider, fetcher } = setup();
    await expect(provider.connection!.connect!({ ...values, auth: 'unknown' })).rejects.toMatchObject({ code: 'unsupported-auth' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not switch an existing authentication scope or account through blank credentials', async () => {
    const { provider, fetcher } = setup([Response.json(catalog)]);
    const a = await provider.connection!.connect!(values);
    const configuration = await provider.connection!.configuration!(a);
    await expect(provider.connection!.connect!({ ...configuration, auth: 'anonymous' }, a)).rejects.toMatchObject({ code: 'scope-blocked' });
    await expect(provider.connection!.connect!({ ...configuration, auth: 'url-token', tokenUrl: ROOT }, a)).rejects.toMatchObject({ code: 'scope-blocked' });
    await expect(provider.connection!.connect!({ ...configuration, username: 'another-account', password: '' }, a)).rejects.toMatchObject({ code: 'scope-blocked' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale edit configuration before making another request', async () => {
    const { provider, store, fetcher } = setup([Response.json(catalog), Response.json(catalog)]);
    const a = await provider.connection!.connect!(values);
    const stale = await provider.connection!.configuration!(a);
    await provider.connection!.connect!({ ...stale, name: 'Latest', password: 'new-password' }, a);
    await expect(provider.connection!.connect!({ ...stale, name: 'Outdated', password: '' }, a)).rejects.toMatchObject({ code: 'disconnected' });
    expect((await store.connection(a.id))!.name).toBe('Latest');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not overwrite a concurrent edit when an earlier validation request finishes late', async () => {
    const { provider, store, fetcher } = setup([Response.json(catalog)]);
    const a = await provider.connection!.connect!(values);
    const configuration = await provider.connection!.configuration!(a);
    let resolveRequest!: (response: Response) => void;
    let started!: () => void;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const requested = new Promise<void>((resolve) => { started = resolve; });
    fetcher.mockImplementationOnce(async () => { started(); return pending; });
    fetcher.mockResolvedValueOnce(Response.json(catalog));
    const earlier = provider.connection!.connect!({ ...configuration, name: 'Earlier', password: 'earlier-password' }, a);
    await requested;
    await provider.connection!.connect!({ ...configuration, name: 'Latest', password: 'latest-password' }, a);
    resolveRequest(Response.json(catalog));
    await expect(earlier).rejects.toMatchObject({ code: 'disconnected' });
    expect((await store.connection(a.id))!.name).toBe('Latest');
    expect((await store.connection(a.id))!.auth).toMatchObject({ password: 'latest-password' });
  });
  it('removes private reading bindings and accounts with retry-safe notifications', async () => {
    const { provider, store } = setup([Response.json(catalog), Response.json(manifest)]);
    const a = await provider.connection!.connect!(values);
    const page = await provider.catalog!.browse({ connection: publicConnection(a) });
    const plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    const changed = vi.fn();
    const accessLost = vi.fn(async () => {});
    provider.connection!.subscribe!(changed);
    provider.subscribe!(accessLost);
    await provider.connection!.remove!(a);
    expect(await store.connection(a.id)).toBeUndefined();
    expect(await store.resource(plan.representationId)).toBeUndefined();
    expect(await store.resource(page.publications[0].id)).toBeUndefined();
    expect(await provider.connection!.list!()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(accessLost).toHaveBeenCalledWith({ connectionId: a.id });
    await provider.connection!.remove!(a);
    expect(await store.connections()).toEqual([]);
  });
  it('does not recreate a removed connection when a pending edit finishes late', async () => {
    const { provider, store, fetcher } = setup([Response.json(catalog)]);
    const a = await provider.connection!.connect!(values);
    const configuration = await provider.connection!.configuration!(a);
    let resolveRequest!: (response: Response) => void;
    let started!: () => void;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const requested = new Promise<void>((resolve) => { started = resolve; });
    fetcher.mockImplementationOnce(async () => { started(); return pending; });
    const reconnect = provider.connection!.connect!({ ...configuration, password: 'late-password' }, a);
    await requested;
    await provider.connection!.remove!(a);
    resolveRequest(Response.json(catalog));
    await expect(reconnect).rejects.toMatchObject({ code: 'disconnected' });
    expect(await store.connections()).toEqual([]);
  });
  it('browses without importing/fetching covers or pages and exposes no transport URL or credentials', async () => {
    const { provider, fetcher } = setup([Response.json(catalog)]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
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
  it('uses only the preferred direct file size without fetching details or borrowing alternate sizes', async () => {
    const book = (title: string, links: unknown[]) => ({ metadata: { title }, links });
    const pdf = { rel: 'download', href: '/book.pdf', type: 'application/pdf' };
    const cbz = { rel: 'download', href: '/book.cbz', type: 'application/zip', size: 987654 };
    const sized = {
      metadata: { title: 'Sizes' },
      publications: [
        book('Preferred PDF', [{ rel: 'self', href: '/book', size: 1 }, { ...pdf, size: 123456 }, cbz]),
        book('Unknown preferred size', [pdf, cbz]),
        book('Invalid preferred size', [{ ...pdf, size: -1 }, cbz]),
        book('Direct file only', [
          { ...pdf, rel: 'borrow', size: 11 },
          { ...pdf, size: 22, properties: { indirectAcquisition: [{ type: 'application/pdf' }] } },
          { ...pdf, size: 33, properties: { encrypted: { scheme: 'drm' } } },
          cbz,
        ]),
        book('Borrow only', [{ ...pdf, rel: 'borrow', size: 44 }]),
      ],
    };
    const { provider, fetcher } = setup([Response.json(sized)]);
    const account = await provider.connection!.connect!(values);
    const connection = publicConnection(account);
    const page = await provider.catalog!.browse({ connection });
    expect(page.publications.map((item) => item.size)).toEqual([123456, undefined, undefined, 987654, undefined]);
    expect(page.publications[0].formats).toEqual(['pdf', 'cbz']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const plan = await provider.catalog!.resolve(connection, page.publications[0].id);
    expect(plan.format).toBe('pdf');
    expect(plan.publication.size).toBe(123456);
    // Catalog lengths are display hints; range/download bindings still use verified transport sizes.
    expect(plan.size).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses the validated connect result once and fetches an explicit refresh', async () => {
    const refreshed = { ...catalog, metadata: { title: 'Refreshed library' } };
    const { provider, fetcher } = setup([Response.json(catalog), Response.json(refreshed)]);
    const account = await provider.connection!.connect!(values);
    const connection = publicConnection(account);

    expect((await provider.catalog!.browse({ connection })).title).toBe('Library');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await provider.catalog!.browse({ connection })).title).toBe('Refreshed library');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([ROOT, ROOT]);
  });
  it.each([
    {
      name: 'a publication without an identity or acquisition link',
      feed: { metadata: { title: 'Invalid' }, publications: [{ metadata: { title: 'Unknown' } }] },
      code: 'unsupported',
    },
    {
      name: 'more than 2000 normalized references',
      feed: {
        metadata: { title: 'Too large' },
        navigation: Array.from({ length: 2000 }, (_, index) => ({
          title: `Directory ${index}`,
          href: `/directory/${index}`,
        })),
      },
      code: 'too-large',
    },
  ])('does not persist credentials for $name', async ({ feed, code }) => {
    const { provider, store } = setup([Response.json(feed)]);
    const save = vi.spyOn(store, 'saveConnection');

    await expect(provider.connection!.connect!(values)).rejects.toMatchObject({ code });

    expect(save).not.toHaveBeenCalled();
    expect(await store.connections()).toEqual([]);
  });
  it('reuses the discovered OpenSearch template across different searches', async () => {
    const feed = {
      metadata: { title: 'Searchable library' },
      links: [
        { rel: 'search', href: '/opensearch', type: 'application/opensearchdescription+xml' },
      ],
      publications: [],
    };
    const description =
      '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><Url type="application/opds+json" template="https://catalog.example/search?query={searchTerms}"/></OpenSearchDescription>';
    const { provider, fetcher } = setup([
      Response.json(feed),
      new Response(description),
      Response.json({ metadata: { title: 'Duck results' }, publications: [] }),
      Response.json({ metadata: { title: 'Whale results' }, publications: [] }),
    ]);
    const account = await provider.connection!.connect!(values);
    const connection = publicConnection(account);
    await provider.catalog!.browse({ connection });

    expect((await provider.catalog!.browse({ connection, search: 'duck' })).title).toBe(
      'Duck results',
    );
    expect((await provider.catalog!.browse({ connection, search: 'whale' })).title).toBe(
      'Whale results',
    );

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      ROOT,
      'https://catalog.example/opensearch',
      'https://catalog.example/search?query=duck',
      'https://catalog.example/search?query=whale',
    ]);
  });
  it('resolves image-only manifest and reads originals through opaque descriptors', async () => {
    const { provider } = setup([
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
      one = await provider.catalog!.browse({ connection: publicConnection(a), search: 'duck' });
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
  it('returns an explicit EPUB download plan when Range is unsupported without consuming its body', async () => {
    const feed = {
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
    const cancel = vi.fn();
    const { provider, fetcher } = setup([
        Response.json(feed), new Response(new ReadableStream({ cancel }), { status: 200 }),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    await expect(
      provider.catalog!.resolve(publicConnection(a), page.publications[0].id),
    ).resolves.toMatchObject({ kind: 'download-file', format: 'epub' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get('Range')).toBe('bytes=0-0');
    expect(cancel).toHaveBeenCalledOnce();
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
      { provider, fetcher } = setup([Response.json(feed), Response.json(manifest)]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(page.publications[0].readable).toBe(true);
    expect(page.publications[0].reason).toBeUndefined();
    const plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    expect(plan.kind).toBe('pages');
    expect(plan.publication.readable).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('chooses EPUB Range reading after an XHTML manifest without fetching document content', async () => {
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
        Response.json(feed), Response.json(full),
        new Response(new Uint8Array([80]), { status: 206, headers: { 'Content-Range': 'bytes 0-0/100', ETag: '"epub-1"' } }),
      ]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    await expect(
      provider.catalog!.resolve(publicConnection(a), page.publications[0].id),
    ).resolves.toMatchObject({ kind: 'range-file', format: 'epub' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.lastCall?.[0]).toBe('https://catalog.example/book.epub');
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get('Range')).toBe('bytes=0-0');
  });
  it('resolves an Atom partial entry with quoted MIME parameters and an EPUB alternative', async () => {
    const feed =
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Books</title><entry><id>book:1</id><title>Book</title><link rel="alternate" type="application/atom+xml; TYPE=&quot;entry&quot;; profile=opds-catalog" href="/complete"/><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/book.epub"/></entry></feed>';
    const full =
      '<entry xmlns="http://www.w3.org/2005/Atom"><id>book:1</id><title>Book</title><link rel="http://opds-spec.org/acquisition" type="application/pdf" href="/book.pdf"/></entry>';
    const { provider, fetcher } = setup([new Response(feed), new Response(full)]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(page.publications[0].readable).toBe(true);
    const plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    expect(plan.format).toBe('pdf');
    expect(plan.publication.id).toBe(page.publications[0].id);
    expect(fetcher.mock.lastCall?.[0]).toBe('https://catalog.example/complete');
  });
  it('supports embedded image readingOrder and does not use covers as pages', async () => {
    const book = { ...manifest, links: [{ href: '/book/1', rel: 'self' }] },
      feed = { metadata: { title: 'Books' }, publications: [book] };
    const { provider, fetcher } = setup([Response.json(feed), Response.json(feed)]),
      a = await provider.connection!.connect!(values),
      page = await provider.catalog!.browse({
        connection: publicConnection(a),
      });
    expect(page.publications[0].readable).toBe(true);
    const plan = await provider.catalog!.resolve(publicConnection(a), page.publications[0].id);
    expect((await provider.pages!.index(context(a, plan))).total).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    const { provider, fetcher } = setup([Response.json(feed)]),
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
    expect(fetcher).toHaveBeenCalledTimes(1);
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
      const { provider, fetcher } = setup([Response.json(feed)]),
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
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { format: 'cbz', type: 'application/zip' },
    { format: 'epub', type: 'application/epub+zip' },
  ])('keeps a $format Range representation identical when explicitly downloading the same file', async ({ format, type }) => {
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
            { rel: 'acquisition', href: '/file.' + format, type },
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
  it('does not let late cleanup detach requests made after reconnect', async () => {
    const requests: { signal: AbortSignal; reject: (error: Error) => void }[] = [];
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requests.push({ signal: init!.signal!, reject });
        }),
    );
    const transport = new OpdsTransport(fetcher);
    const pending: Promise<unknown>[] = [];
    try {
      const first = transport.bytes(connection, ROOT).catch((error: unknown) => error);
      pending.push(first);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      transport.abortConnection(connection.id);
      expect(requests[0].signal.aborted).toBe(true);

      pending.push(
        transport.bytes({ ...connection, revision: 2 }, ROOT).catch((error: unknown) => error),
        transport
          .bytes({ ...connection, id: 'independent-connection' }, ROOT)
          .catch((error: unknown) => error),
      );
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      requests[0].reject(new DOMException('Stopped', 'AbortError'));
      await first;

      transport.abortConnection(connection.id);
      expect(requests[1].signal.aborted).toBe(true);
      expect(requests[2].signal.aborted).toBe(false);
    } finally {
      for (const request of requests) request.reject(new DOMException('Stopped', 'AbortError'));
      await Promise.all(pending);
    }
  });
  it('validates queued credentials after admission without a second preflight read', async () => {
    const responses: ((response: Response) => void)[] = [];
    const fetcher = vi.fn<typeof fetch>(
      async () => new Promise<Response>((resolve) => responses.push(resolve)),
    );
    let queuedConnectionActive = true;
    const validate = vi.fn(async (current: PrivateConnection) => {
      if (current.id === 'queued' && !queuedConnectionActive) throw Error('revoked');
    });
    const transport = new OpdsTransport(fetcher, validate);
    const running = Array.from({ length: 4 }, (_, index) =>
      transport.bytes({ ...connection, id: `occupied-${index}` }, ROOT),
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    const queued = transport
      .bytes({ ...connection, id: 'queued' }, ROOT)
      .catch((error: unknown) => error);
    try {
      queuedConnectionActive = false;
      responses[0](new Response('ready'));
      await running[0];
      await expect(queued).resolves.toMatchObject({ code: 'network' });
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(validate.mock.calls.filter(([current]) => current.id === 'queued')).toHaveLength(1);
    } finally {
      for (const respond of responses) respond(new Response('ready'));
      await Promise.all(running);
    }
  });
  it('does not fetch when disconnect occurs during the authorization check', async () => {
    let authorized!: () => void;
    const checking = new Promise<void>((resolve) => {
      authorized = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response('unused'));
    const validate = vi.fn(async () => checking);
    const transport = new OpdsTransport(fetcher, validate);
    const pending = transport.bytes(connection, ROOT).catch((error: unknown) => error);
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    transport.abortConnection(connection.id);
    authorized();
    await expect(pending).resolves.toMatchObject({ code: 'network' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'PATCH'] as const)(
    'uses the credential-scoped transport for discovered %s progress targets',
    async (method) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      const validate = vi.fn(async () => {});
      const transport = new OpdsTransport(fetcher, validate);
      const target = { method, url: ROOT + '/progress' } as OpdsProgressTarget;
      const payload = { page: 4, completed: false };

      await expect(transport.writeProgress(connection, target, payload)).resolves.toBeUndefined();

      expect(fetcher).toHaveBeenCalledOnce();
      expect(validate).toHaveBeenCalledTimes(2);
      const [url, init] = fetcher.mock.calls[0];
      expect(url).toBe(target.url);
      expect(init).toMatchObject({
        method,
        body: JSON.stringify(payload),
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      const headers = new Headers(init!.headers);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('Authorization')).toBe('Basic ' + btoa('user:secret'));
      expect(headers.has('Cookie')).toBe(false);
    },
  );
  it('rejects an external progress target and oversized progress payload before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = new OpdsTransport(fetcher);
    await expect(
      transport.writeProgress(
        connection,
        { method: 'POST', url: 'https://other.example/progress' } as OpdsProgressTarget,
        { page: 4 },
      ),
    ).rejects.toMatchObject({ code: 'scope-blocked' });
    await expect(
      transport.writeProgress(
        connection,
        { method: 'POST', url: ROOT + '/progress' } as OpdsProgressTarget,
        { value: 'x'.repeat(128 * 1024) },
      ),
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds progress responses without retaining the response body', async () => {
    const cancel = vi.fn();
    const transport = new OpdsTransport(
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(128 * 1024 + 1));
              },
              cancel,
            }),
          ),
      ),
    );
    await expect(
      transport.writeProgress(
        connection,
        { method: 'PATCH', url: ROOT + '/progress' } as OpdsProgressTarget,
        { page: 4 },
      ),
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(cancel).toHaveBeenCalledOnce();
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
  it.each([
    { status: 401, code: 'authentication-required', message: '身份认证失败' },
    { status: 403, code: 'access-denied', message: '文件下载权限' },
  ])('keeps HTTP $status distinct for catalog, Range and complete-file reads', async ({ status, code, message }) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('private server response', { status }));
    const transport = new OpdsTransport(fetcher);
    for (const operation of [
      () => transport.document(connection, ROOT),
      () => transport.bytes(connection, ROOT, { headers: { Range: 'bytes=0-0' }, status: 206 }),
      () => transport.download(connection, ROOT),
    ]) {
      const error = await operation().catch((value: unknown) => value);
      expect(error).toMatchObject({ code, details: { status }, message: expect.stringContaining(message) });
      expect((error as Error).message).not.toContain('private');
      if (status === 403) expect((error as Error).message).not.toContain('更新连接授权');
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
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
  it('identifies the public Moby Dick EPUB and probes Range without downloading its body', async () => {
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
    expect(book!.readable).toBe(true);
    const plan = await provider.catalog!.resolve(connection, book!.id);
    expect(plan.format).toBe('epub');
    expect(['range-file', 'download-file']).toContain(plan.kind);
    expect(Object.keys(readingTypes)).toEqual(['application/xhtml+xml']);
    expect(methods).toEqual(['GET', 'GET', 'GET']);
    console.info(
      JSON.stringify({
        service: 'official-komga-demo',
        title: book!.title,
        readingTypes,
        getRequests: methods.length,
        requiresExplicitEpubDownload: plan.kind === 'download-file',
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
