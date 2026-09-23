import {existsSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {listSupportedSites} from '../src/sources/registry/sites';
import {definitions} from '../src/sources/registry/definitions';

describe('adapter-owned website directory', () => {
  it('flattens multiple sites from one adapter without coupling the view to its id', () => {
    const adapter = definitions.find(value => value.id === 'mangacopy')!;
    const sites = listSupportedSites([{...adapter, id: 'custom-adapter', sites: [
      {id: 'one', name: 'One', url: 'https://one.example/', icon: '/one.svg'},
      {id: 'two', name: 'Two', url: 'https://two.example/', icon: '/two.svg'},
    ]}]);
    expect(sites.map(site => [site.key, site.name, site.icon])).toEqual([
      ['custom-adapter:one', 'One', '/one.svg'], ['custom-adapter:two', 'Two', '/two.svg'],
    ]);
    expect(listSupportedSites([{...adapter, capabilities: {...adapter.capabilities, importable: false}}])).toEqual([]);
    expect(listSupportedSites([{...adapter, sites: undefined}])).toEqual([]);
  });
  it('ships complete, unique website metadata and packaged icons', () => {
    const sites = listSupportedSites();
    expect(new Set(sites.map(site => site.key)).size).toBe(sites.length);
    for (const site of sites) {
      expect(site.name.trim()).not.toBe('');
      expect(new URL(site.url).protocol).toBe('https:');
      expect(site.icon).toMatch(/^\/site-icons\/[a-z-]+\.svg$/);
      expect(existsSync(new URL('../public' + site.icon, import.meta.url))).toBe(true);
    }
  });
});
