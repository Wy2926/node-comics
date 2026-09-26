import { describe, expect, it, vi } from 'vitest';
import {
  createSourceService, pollSourceDiscovery, sameSourcePage, sourceFor, sourceInstallation, sourcePageIdentity, validateSourceCatalog, type SourceCatalogSnapshot, type SourceDefinition, type SourceSnapshot, } from '../src/sources';
import { validateCatalog } from '../src/sources/core/catalog';
import { SourceNavigation } from '../src/sources/core/navigation';
import { validatePages } from '../src/sources/core/pages';
import { resolveSource } from '../src/sources/core/resolve';
import { createSourceNavigation, PageImageRegistry, type CreateSourcePage } from '../src/sources/page';
import { definitions } from '../src/sources/registry/definitions';
import { pageFactories } from '../src/sources/registry/pages';
import { sourceNetworks } from '../src/sources/registry/networks';
import {validateSearchCapability} from '../src/sources/core/search';
const chapter = '724f819b-5306-11ea-b7ea-024352452ce0';
const sourceUrl = 'https://www.mangacopy.com/comic/sample/chapter/' + chapter;
const testDefinition: SourceDefinition = {
  id: 'fixture',
  name: 'Fixture',
  capabilities: { pages: true, inline: true, catalog: true, completePageList: true },
  installation: { requiredOrigins: [], autoContentMatches: [] },
  identify(url) {
    return url.hostname === 'fixture.test'
      ? {
          sourceId: this.id,
          pageKey: this.id + ':' + url.pathname,
          kind: url.pathname === '/work' ? 'catalog' : 'reader',
          url: url.href,
          catalog: { key: 'fixture:work', url: 'https://fixture.test/work' },
        }
      : null;
  },
};
const testCatalog: SourceCatalogSnapshot = {
  id: 'fixture:work',
  sourceId: 'fixture',
  url: 'https://fixture.test/work',
  title: 'Fixture',
  observedAt: 1,
  complete: true,
  note: '',
  groups: [{ id: 'main', title: 'Main', entryIds: ['chapter'], complete: true }],
  entries: [
    {
      id: 'chapter',
      remoteId: '1',
      catalogId: 'fixture:work',
      url: 'https://fixture.test/work/1',
      title: 'One',
      order: 0,
      groupIds: ['main'],
      rawTypes: [],
      related: false,
    },
  ],
};
describe('source composition and identity', () => {
  it('aligns optional search implementations, site coverage and declared operation permissions', () => {
    for (const definition of definitions) {
      const searchable = (definition.sites ?? []).filter(site => site.search);
      expect(!!sourceNetworks[definition.id]?.search).toBe(searchable.length > 0);
      for (const site of searchable) expect(() => validateSearchCapability(definition, site)).not.toThrow();
    }
  });
  it('cancels a discovery message that has not responded', async () => {
    const controller = new AbortController(),
      poll = vi.fn(() => new Promise<never>(() => {})),
      pending = pollSourceDiscovery(poll, { signal: controller.signal });
    await Promise.resolve();
    expect(poll).toHaveBeenCalledOnce();
    controller.abort(Error('paused'));
    await expect(pending).rejects.toThrow('paused');
  });
  it('keeps registry IDs and capabilities aligned with page factories', () => {
    expect(Object.keys(pageFactories).every(id=>definitions.some(d=>d.id===id))).toBe(true);
    for (const definition of definitions) {
      if(!pageFactories[definition.id]){
        expect(definition.capabilities.inline).toBe(false);
        if(definition.capabilities.pages)expect(sourceNetworks[definition.id]?.pages).toBeTypeOf('function');
        if(definition.capabilities.catalog)expect(sourceNetworks[definition.id]?.catalog).toBeTypeOf('function');
        continue;
      }
      const controller = new AbortController();
      const session = pageFactories[definition.id]({
        document: {} as Document,
        location: { sourceId: definition.id, pageKey: 'test', kind: 'reader', url: 'https://example.test' },
        signal: controller.signal,
      });
      expect(typeof session.discoverPages).toBe('function');
      expect(typeof session.inlineTargets).toBe('function');
      expect(!!session.discoverCatalog||!!sourceNetworks[definition.id]?.catalog).toBe(definition.capabilities.catalog);
      session.dispose();
    }
  });
  it('keeps full generic query and hash identities and detects conflicts', () => {
    expect(sourcePageIdentity('https://example.test/?chapter=1#page2')).toBe(
      'https://example.test/?chapter=1#page2',
    );
    expect(sameSourcePage('https://example.test/?chapter=1', 'https://example.test/?chapter=2')).toBe(false);
    expect(() =>
      resolveSource(testCatalog.url, [
        ...definitions,
        testDefinition,
        { ...testDefinition, id: 'duplicate' },
      ]),
    ).toThrow('CONFLICT');
    expect(() => sourceFor('https://user:secret@example.test')).toThrow('INVALID_SOURCE_URL');
  });
  it('keeps automatic script matches distinct from global host access', () => {
    expect(sourceInstallation.autoContentMatches).toEqual([
      'https://*.mangacopy.com/comic/*',
      'https://*.copy4000.com/comic/*',
    ]);
  });
  it('shares only declared mirror identities, never another work or a forged hostname', () => {
    expect(sameSourcePage(sourceUrl, sourceUrl.replace('www.mangacopy.com', 'copy4000.com'))).toBe(true);
    expect(sameSourcePage(sourceUrl, sourceUrl.replace('sample', 'different'))).toBe(false);
    expect(sameSourcePage(sourceUrl, sourceUrl.replace('mangacopy.com', 'mangacopy.com.evil.test'))).toBe(
      false,
    );
  });
  it('does not fall back to advertisements when a recognized site waits or fails', async () => {
    const genericScan = vi.fn(() => {
      throw Error('Must not scan ads');
    });
    const doc = {
      title: 'Waiting',
      querySelector: () => null,
      querySelectorAll: (selector: string) => (selector === 'img' ? genericScan() : []),
    } as unknown as Document;
    const navigation = new SourceNavigation(doc, definitions, pageFactories);
    expect(await navigation.get(sourceUrl).session.discoverPages()).toMatchObject({
      status: 'not-ready',
      partial: { items: [] },
    });
    expect(await navigation.get('https://mangacopy.com/unsupported').session.discoverPages()).toMatchObject({
      status: 'unsupported',
    });
    expect(genericScan).not.toHaveBeenCalled();
    navigation.dispose();
  });
  it('can add a catalog site without changing the host, library or translation code', async () => {
    const snapshot: SourceSnapshot = {
      title: 'One',
      url: testCatalog.entries[0].url,
      adapter: 'fixture',
      direction: 'ltr',
      discoveryComplete: true,
      knownTotal: 1,
      note: '',
      items: [
        {
          id: 'slot-0',
          width: 800,
          height: 1200,
          order: 0,
          resource: { kind: 'http', url: 'https://images.test/one.png' },
        },
      ],
    };
    const factory: CreateSourcePage = () => ({
      direction: 'ltr',
      snapshot: () => snapshot,
      discoverPages: async () => ({ status: 'ready', value: snapshot }),
      discoverCatalog: () => ({ status: 'ready', value: testCatalog }),
      inlineTargets: () => [],
      dispose: () => {},
    });
    const registry = [...definitions, testDefinition],
      navigation = createSourceNavigation({} as Document, undefined, {
        definitions: registry,
        pages: { ...pageFactories, fixture: factory },
      });
    expect(createSourceService(registry).validateCatalog(testCatalog)).toEqual(testCatalog);
    const page = navigation.get(snapshot.url);
    expect((await page.session.discoverPages()).status).toBe('ready');
    expect(validatePages(snapshot, page.location)).toBe(snapshot);
    navigation.dispose();
  });
  it('aborts and disposes on navigation, including an A-B-A visit', () => {
    const dispose = vi.fn(),
      invalidated = vi.fn(),
      factory: CreateSourcePage = () => ({
        direction: 'ltr',
        snapshot: vi.fn(),
        discoverPages: vi.fn(),
        discoverCatalog: vi.fn(),
        inlineTargets: () => [],
        dispose,
      });
    const navigation = new SourceNavigation(
      {} as Document,
      [...definitions, testDefinition],
      { ...pageFactories, fixture: factory },
      invalidated,
    );
    const a = navigation.get('https://fixture.test/work/1');
    expect(navigation.get(a.url)).toBe(a);
    navigation.get('https://fixture.test/work/2');
    const second = navigation.get(a.url);
    expect(a.controller.signal.aborted).toBe(true);
    expect(second.navigationId).not.toBe(a.navigationId);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(invalidated).toHaveBeenCalledTimes(2);
    navigation.dispose();
  });
});
describe('catalog ownership and normalized suggestions', () => {
  it.each([
    (c: SourceCatalogSnapshot) => c.entries.push(c.entries[0]),
    (c: SourceCatalogSnapshot) => c.entries[0].groupIds.push('missing'),
    (c: SourceCatalogSnapshot) => c.groups[0].entryIds.push('missing'),
    (c: SourceCatalogSnapshot) => {
      c.entries[0].url = sourceUrl;
    },
    (c: SourceCatalogSnapshot) => {
      c.sourceId = 'unknown';
    },
    (c: SourceCatalogSnapshot) => {
      c.entries[0].order = -1;
    },
  ])('rejects malformed catalogs', (mutate) => {
    const catalog = structuredClone(testCatalog);
    mutate(catalog);
    expect(() => validateCatalog(catalog, [...definitions, testDefinition])).toThrow();
  });
  it('rejects known source entries from another work and strips library bindings', () => {
    const catalog = {
      ...testCatalog,
      id: 'mangacopy:sample',
      sourceId: 'mangacopy',
      url: 'https://mangacopy.com/comic/sample',
      entries: [{ ...testCatalog.entries[0], catalogId: 'mangacopy:sample', url: sourceUrl }],
    };
    expect(
      validateSourceCatalog({ ...catalog, comicId: 'forged', excludedEntryIds: ['chapter'] }),
    ).not.toHaveProperty('comicId');
    expect(() =>
      validateSourceCatalog({
        ...catalog,
        entries: [{ ...catalog.entries[0], url: sourceUrl.replace('sample', 'other') }],
      }),
    ).toThrow();
  });
  it('preserves adapter-defined labels and nesting while rejecting cycles',()=>{
    const source=structuredClone(testCatalog);source.entries[0].rawTypes=['特别企划','Color'];source.groups.push({id:'root',title:'任意来源分类',entryIds:[],complete:true});source.groups[0].parentId='root';source.defaultEntryId='chapter';
    const valid=validateCatalog(source,[...definitions,testDefinition]);expect(valid.entries[0].rawTypes).toEqual(['特别企划','Color']);expect(valid.groups[0].parentId).toBe('root');expect(valid.defaultEntryId).toBe('chapter');source.groups[1].parentId='main';expect(()=>validateCatalog(source,[...definitions,testDefinition])).toThrow();
  });
});
describe('navigation-scoped page resources', () => {
  it('caches previews by source version, bounds their encoding budget and revokes replaced handles', async () => {
    const registry = new PageImageRegistry();
    const encode = vi.fn(() => 'x'.repeat(100_000));
    const doc = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: encode }) };
    const images = Array.from({ length: 25 }, (_, n) => ({
      element: {
        width: 800,
        height: 1200,
        isConnected: true,
        ownerDocument: doc,
      } as unknown as HTMLCanvasElement,
      key: 'version-1',
      url: 'resource-' + n,
      read: async () => new Blob(['pixels'], { type: 'image/png' }),
    }));
    const snapshot: SourceSnapshot = {
      title: 'Canvas',
      url: 'https://fixture.test/work/1',
      adapter: 'fixture',
      direction: 'rtl',
      note: '',
      discoveryComplete: false,
      items: images.map((image, order) => ({
        id: 'slot-' + order,
        order,
        width: 800,
        height: 1200,
        resource: { kind: 'page', resourceKey: image.url },
      })),
    };
    const first = registry.register(snapshot, images);
    expect(encode).toHaveBeenCalledTimes(20);
    expect(first.items.filter((item) => item.preview)).toHaveLength(20);
    registry.register(snapshot, images);
    expect(encode).toHaveBeenCalledTimes(20);
    images[0] = { ...images[0], key: 'version-2' };
    const next = registry.register(snapshot, images);
    expect(next.items[0].url).not.toBe(first.items[0].url);
    expect(encode).toHaveBeenCalledTimes(21);
    await expect(registry.read(first.items[0].url, snapshot.url, 'slot-0', () => images)).rejects.toThrow(
      '来源已变化',
    );
    registry.clear();
    registry.register(snapshot, images);
    expect(encode).toHaveBeenCalledTimes(41);
  });
  function fixture() {
    const element = { width: 800, height: 1200, isConnected: true } as HTMLCanvasElement;
    const read = vi.fn(async () => new Blob(['pixels'], { type: 'image/png' }));
    const image = { element, key: 'version-1', url: 'site-chosen-key', read };
    const snapshot: SourceSnapshot = {
      title: 'Canvas',
      url: 'https://fixture.test/work/1',
      adapter: 'fixture',
      direction: 'rtl',
      note: '',
      discoveryComplete: false,
      items: [
        {
          id: 'slot-1',
          order: 1,
          width: 800,
          height: 1200,
          resource: { kind: 'page', resourceKey: image.url },
        },
      ],
    };
    return { image, snapshot, registry: new PageImageRegistry() };
  }
  it('issues opaque handles, reuses current registration and revokes on clear', async () => {
    const { image, snapshot, registry } = fixture(),
      first = await registry.register(snapshot, [image]),
      handle = first.items[0].url;
    expect(handle).toMatch(/^page-image:/);
    expect(handle).not.toContain(image.url);
    expect((await registry.register(snapshot, [image])).items[0].url).toBe(handle);
    expect(await registry.read(handle, snapshot.url, 'slot-1', () => [image])).toMatch(/^data:image\/png/);
    registry.clear();
    await expect(registry.read(handle, snapshot.url, 'slot-1', () => [image])).rejects.toThrow();
  });
  it('rejects a version change during encoding and aborts pending reads', async () => {
    const { image, snapshot, registry } = fixture();
    let done!: (blob: Blob) => void;
    image.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const handle = (await registry.register(snapshot, [image])).items[0].url;
    let current = image;
    const read = registry.read(handle, snapshot.url, 'slot-1', () => [current]);
    current = { ...image, key: 'version-2' };
    done(new Blob(['old']));
    await expect(read).rejects.toThrow();
    current = image;
    const controller = new AbortController(),
      pending = registry.read(handle, snapshot.url, 'slot-1', () => [current], controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('EXPIRED');
    done(new Blob(['old']));
  });
});
