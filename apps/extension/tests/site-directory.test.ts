import {existsSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {listSupportedSites} from '../src/sources/registry/sites';
import {definitions} from '../src/sources/registry/definitions';

describe('adapter-owned website directory', () => {
  it('flattens multiple sites from one adapter without coupling the view to its id', () => {
    const adapter = definitions.find(value => value.id === 'mangacopy')!;
    const sites = listSupportedSites([{...adapter, id: 'custom-adapter', sites: [
      {id: 'one', name: 'One', url: 'https://one.example/', icon: '/one.svg', primaryLanguages: ['en', 'ja'], adaptedOn: '2026-09-23', contentTags: ['manga']},
      {id: 'two', name: 'Two', url: 'https://two.example/', icon: '/two.svg', primaryLanguages: ['ko'], adaptedOn: '2026-09-23', contentTags: ['manhwa', 'webtoon']},
    ]}]);
    expect(sites.map(site => [site.key, site.name, site.icon])).toEqual([
      ['custom-adapter:one', 'One', '/one.svg'], ['custom-adapter:two', 'Two', '/two.svg'],
    ]);
    expect(listSupportedSites([{...adapter, capabilities: {...adapter.capabilities, importable: false}}])).toEqual([]);
    expect(listSupportedSites([{...adapter, sites: undefined}])).toEqual([]);
  });
  it('orders dates newest first across adapters and preserves equal-date entry order', () => {
    const adapter = definitions.find(value => value.id === 'mangacopy')!;
    const sites = [
      {...adapter.sites![0], id: 'old', adaptedOn: '2025-12-31', isFree: true},
      {...adapter.sites![0], id: 'new', adaptedOn: '2026-10-04'},
      {...adapter.sites![0], id: 'same-day', adaptedOn: '2026-10-04', isFree: false},
    ];
    const result = listSupportedSites([
      {...adapter, sites: sites.slice(0, 2)},
      {...adapter, id: 'other', sites: sites.slice(2)},
    ]);
    expect(result.map(site => [site.key, site.isFree])).toEqual([
      ['mangacopy:new', undefined], ['other:same-day', false], ['mangacopy:old', true],
    ]);
    expect(sites.map(site => site.id)).toEqual(['old', 'new', 'same-day']);
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
      expect(site.contentTags.length).toBeLessThanOrEqual(3);
      expect(new Set(site.contentTags).size).toBe(site.contentTags.length);
      expect(new Set(site.accessTags).size).toBe(site.accessTags?.length ?? 0);
      for (const tag of site.accessTags ?? []) expect(['login-required', 'partial-web', 'paid-content']).toContain(tag);
      if (site.isFree) expect(site.accessTags ?? []).not.toContain('paid-content');
      if(site.icon.startsWith('data:image/svg+xml,')) {
        expect(decodeURIComponent(site.icon.slice('data:image/svg+xml,'.length))).toMatch(/^<svg\b/);
      } else {
        expect(site.icon).toMatch(/^\/site-icons\/[a-z-]+\.svg$/);
        expect(existsSync(new URL('../public' + site.icon, import.meta.url))).toBe(true);
      }
    }
  });
});
