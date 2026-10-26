import {existsSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {listSupportedSites, sortSupportedSites, matchesSiteFilters, type SiteFilters} from '../src/sources/registry/sites';
import type {SourceSite} from '../src/sources/contracts/definition';
import {definitions} from '../src/sources/registry/definitions';

describe('adapter-owned website directory', () => {
  it('flattens multiple sites from one adapter without coupling the view to its id', () => {
    const adapter = definitions.find(value => value.id === 'mangacopy')!;
    const sites = listSupportedSites([{...adapter, id: 'custom-adapter', sites: [
      {id: 'one', name: 'One', url: 'https://one.example/', icon: '/one.svg', primaryLanguages: ['en', 'ja'], adaptedOn: '2026-09-23', contentTags: ['manga'], pricing: 'free', isRaw: false},
      {id: 'two', name: 'Two', url: 'https://two.example/', icon: '/two.svg', primaryLanguages: ['ko'], adaptedOn: '2026-09-23', contentTags: ['manhwa', 'webtoon'], pricing: 'freemium', isRaw: true},
    ]}]);
    expect(sites.map(site => [site.key, site.name, site.icon])).toEqual([
      ['custom-adapter:one', 'One', '/one.svg'], ['custom-adapter:two', 'Two', '/two.svg'],
    ]);
    expect(listSupportedSites([{...adapter, capabilities: {...adapter.capabilities, importable: false}}])).toEqual([]);
    expect(listSupportedSites([{...adapter, sites: undefined}])).toEqual([]);
  });
  it('orders dates across adapters regardless of pricing without mutating declarations', () => {
    const adapter = definitions.find(value => value.id === 'mangacopy')!;
    const sites: SourceSite[] = [
      {...adapter.sites![0], id: 'old', adaptedOn: '2025-12-31', pricing: 'free'},
      {...adapter.sites![0], id: 'new', adaptedOn: '2026-10-04', pricing: 'unknown'},
      {...adapter.sites![0], id: 'same-day', adaptedOn: '2026-10-04', pricing: 'freemium'},
    ];
    const result = listSupportedSites([
      {...adapter, sites: sites.slice(0, 2)},
      {...adapter, id: 'other', sites: sites.slice(2)},
    ]);
    expect(result.map(site => [site.key, site.pricing])).toEqual([
      ['mangacopy:new', 'unknown'], ['other:same-day', 'freemium'], ['mangacopy:old', 'free'],
    ]);
    expect(sites.map(site => site.id)).toEqual(['old', 'new', 'same-day']);
  });
  it('pins favorites then orders by newest date only; ties keep declaration order', () => {
    const base = definitions.find(value => value.id === 'mangacopy')!.sites![0];
    const make = (key: string, isRaw: boolean, pricing: SourceSite['pricing'], adaptedOn = '2026-10-01') => ({...base, key, isRaw, pricing, adaptedOn});
    const sites = [make('translated-free', false, 'free', '2026-10-26'), make('raw-paid', true, 'freemium', '2026-10-27'),
      make('raw-free-old', true, 'free'), make('raw-free-new', true, 'free', '2026-10-25'),
      make('raw-free-tie', true, 'free', '2026-10-25'), make('translated-unknown', false, 'unknown', '2026-10-28'), make('raw-unknown', true, 'unknown')];
    const normal = ['translated-unknown', 'raw-paid', 'translated-free', 'raw-free-new', 'raw-free-tie', 'raw-free-old', 'raw-unknown'];
    expect(sortSupportedSites(sites).map(site => site.key)).toEqual(normal);
    const favorites = ['raw-free-old', 'translated-free', 'raw-free-tie', 'raw-free-new', 'removed:site'];
    expect(sortSupportedSites(sites, favorites).map(site => site.key))
      .toEqual(['translated-free', 'raw-free-new', 'raw-free-tie', 'raw-free-old', ...normal.filter(key => !favorites.includes(key))]);
    expect(sortSupportedSites(sites, []).map(site => site.key)).toEqual(normal);
    expect(sites[0].key).toBe('translated-free');
  });
  it('ships complete, unique website metadata and packaged icons', () => {
    const sites = listSupportedSites();
    expect(new Set(sites.map(site => site.key)).size).toBe(sites.length);
    for (const site of sites) {
      expect(site.name.trim()).not.toBe('');
      expect(new URL(site.url).protocol).toBe('https:');
      expect(site.adaptedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(site.adaptedOn + 'T00:00:00Z').toISOString().slice(0, 10)).toBe(site.adaptedOn);
      expect(site.contentTags.length).toBeGreaterThan(0);
      expect(new Set(site.contentTags).size).toBe(site.contentTags.length);
      for (const tag of site.contentTags) expect(['western', 'manga', 'manhwa', 'manhua', 'webtoon', 'doujin', 'illustration']).toContain(tag);
      expect(new Set(site.accessTags).size).toBe(site.accessTags?.length ?? 0);
      for (const tag of site.accessTags ?? []) expect(['login-required', 'partial-web']).toContain(tag);
      expect(['free', 'freemium'], site.key).toContain(site.pricing);
      expect(typeof site.isRaw).toBe('boolean');
      expect(site).not.toHaveProperty('isFree');
      if(site.icon.startsWith('data:image/svg+xml,')) {
        expect(decodeURIComponent(site.icon.slice('data:image/svg+xml,'.length))).toMatch(/^<svg\b/);
      } else {
        expect(site.icon).toMatch(/^\/site-icons\/[a-z-]+\.svg$/);
        expect(existsSync(new URL('../public' + site.icon, import.meta.url))).toBe(true);
      }
    }
  });
  it('marks original-language sites explicitly and does not infer raw from manga type', () => {
    const sites = listSupportedSites();
    for (const id of ['rawotaku', 'rawlazy', 'klmanga', 'hachiraw', 'naver', 'comicdays', 'comicwalker', 'pixiv']) {
      expect(sites.find(site => site.adapterId === id)?.isRaw, id).toBe(true);
    }
    for (const id of ['mangacopy', 'mangapill', 'comickz', 'zaimanhua']) {
      expect(sites.filter(site => site.adapterId === id).every(site => !site.isRaw), id).toBe(true);
    }
    expect(sites.find(site => site.adapterId === 'comicdays')?.pricing).toBe('freemium');
    expect(sites.find(site => site.adapterId === 'comictrail')?.pricing).toBe('freemium');
    expect(sites.find(site => site.adapterId === 'mangadot')?.contentTags).toContain('manhua');
    expect(sites.find(site => site.adapterId === 'pixiv')?.contentTags).toContain('illustration');
  });
});

describe('website directory multi-select filters', () => {
  const empty: SiteFilters = {content: [], pricing: [], raw: [], access: []};
  const sites = listSupportedSites();
  const filter = (selection: Partial<SiteFilters>) => sites.filter(site => matchesSiteFilters(site, {...empty, ...selection}));

  it('keeps every entry and priority order when no filters are selected', () => {
    expect(filter({})).toEqual(sites);
  });
  it('lists Western comics separately from manga with the new source metadata', () => {
    expect(filter({content: ['western']})).toEqual([expect.objectContaining({adapterId: 'readcomicsonline', pricing: 'free', primaryLanguages: ['en']})]);
  });
  it('uses OR inside each group and AND between groups without duplicate cards', () => {
    const selected = filter({content: ['manga', 'webtoon'], pricing: ['free', 'freemium'], raw: [true]});
    expect(selected.length).toBeGreaterThan(0);
    expect(selected).toEqual(sites.filter(site => site.isRaw && site.pricing !== 'unknown' && site.contentTags.some(tag => tag === 'manga' || tag === 'webtoon')));
    expect(new Set(selected.map(site => site.key)).size).toBe(selected.length);
    expect(filter({raw: [true, false]})).toEqual(sites);
    expect(filter({pricing: ['free', 'freemium', 'unknown']})).toEqual(sites);
  });
  it('keeps unknown separate from free and combines access conditions', () => {
    const unknown = {...sites[0], pricing: 'unknown' as const};
    expect(matchesSiteFilters(unknown, {...empty, pricing: ['unknown']})).toBe(true);
    expect(matchesSiteFilters(unknown, {...empty, pricing: ['free']})).toBe(false);
    expect(matchesSiteFilters(unknown, {...empty, pricing: ['free', 'freemium']})).toBe(false);
    expect(filter({access: ['login-required', 'partial-web']})).toEqual(sites.filter(site => (site.accessTags?.length ?? 0) > 0));
    expect(filter({content: ['illustration'], pricing: ['freemium']})).toEqual([]);
    expect(filter({content: ['illustration'], pricing: ['free'], raw: [true], access: ['login-required']})).toHaveLength(1);
  });
  it('filters a representative directory locally with bounded work', () => {
    const selection: SiteFilters = {content: ['manga', 'webtoon'], pricing: ['free', 'freemium'], raw: [true], access: []};
    const start = performance.now();
    for (let i = 0; i < 10000; i++) sites.filter(site => matchesSiteFilters(site, selection));
    const elapsed = performance.now() - start;
    console.info(`Directory filtering: ${sites.length} sites, 10000 passes, ${elapsed.toFixed(1)} ms total`);
    expect(elapsed).toBeLessThan(2000);
  });
});
