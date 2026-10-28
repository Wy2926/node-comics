import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { locales, publicPaths } from '../src/i18n';
import { sitesCopy } from '../src/i18n/sites';

test('supported-site copy covers all locales and all adapter label values', () => {
  assert.ok(publicPaths.includes('/sites/'));
  assert.deepEqual(Object.keys(sitesCopy).sort(), [...locales].sort());
  function check(value: unknown, reference: unknown, path: string) {
    if (typeof reference === 'string') {
      assert.equal(typeof value, 'string', path);
      assert.ok((value as string).trim(), path);
      assert.deepEqual((value as string).match(/\{\w+\}/g), reference.match(/\{\w+\}/g), path);
    } else if (reference && typeof reference === 'object') {
      assert.ok(value && typeof value === 'object', path);
      assert.deepEqual(Object.keys(value).sort(), Object.keys(reference).sort(), path);
      for (const [key, entry] of Object.entries(reference)) check((value as Record<string, unknown>)[key], entry, `${path}.${key}`);
    }
  }
  for (const locale of locales) check(sitesCopy[locale], sitesCopy.en, locale);
});

test('website uses the public non-adult extension directory without copying or fetching metadata', async () => {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { supportedSites } = await server.ssrLoadModule('/src/data/supported-sites.ts');
    const { listSupportedSites } = await server.ssrLoadModule(fileURLToPath(new URL('../../../apps/extension/src/sources/registry/sites.ts', import.meta.url)));
    const { definitions } = await server.ssrLoadModule(fileURLToPath(new URL('../../../apps/extension/src/sources/registry/definitions.ts', import.meta.url)));
    const declaredSites = definitions.flatMap((adapter: {id: string; sites?: Record<string, unknown>[]}) =>
      (adapter.sites ?? []).map(site => ({...site, adapterId: adapter.id})));
    const expected = listSupportedSites();
    assert.ok(expected.length > 0);
    // Adult sites retain their adapters and release history, but not public discovery cards.
    const additions = declaredSites.filter((site: { adaptedOn: string }) => site.adaptedOn > '2026-10-13' && site.adaptedOn <= '2026-10-17');
    assert.equal(additions.length, 22, '1.0.0 must include all 22 announced site entries');
    assert.equal(new Set(additions.map((site: { url: string }) => site.url)).size, 22);
    assert.deepEqual(additions.filter((site: { adapterId: string }) => site.adapterId === 'rawkuro').map((site: { id: string }) => site.id).sort(), ['raw1001', 'rawkuro']);
    assert.deepEqual(declaredSites.filter((site: {isAdult: boolean}) => site.isAdult).map((site: {adapterId: string}) => site.adapterId), ['nhentaicom']);
    assert.ok(supportedSites.every((site: {isAdult: boolean}) => site.isAdult === false));
    assert.equal(supportedSites.length, declaredSites.length - 1);
    assert.deepEqual(supportedSites.map(({ icon, anchor, ...site }: Record<string, unknown>) => site), expected.map(({ icon, ...site }: Record<string, unknown>) => site));
    assert.equal(new Set(supportedSites.map((site: { anchor: string }) => site.anchor)).size, expected.length);
    for (const site of supportedSites) {
      assert.ok(['free', 'freemium'].includes(site.pricing), site.key);
      assert.match(site.anchor, /^site-[a-z0-9-]+$/);
      assert.ok(site.icon.startsWith('/') || site.icon.startsWith('data:image/'), site.key);
      assert.doesNotMatch(site.icon, /^\/\//);
      const url = new URL(site.url);
      assert.ok(['http:', 'https:'].includes(url.protocol));
      assert.ok(!url.username && !url.password);
      for (const locale of locales) {
        const copy = sitesCopy[locale];
        assert.ok(copy.pricing[site.pricing as keyof typeof copy.pricing], site.key);
        for (const tag of site.contentTags) assert.ok(copy.content[tag as keyof typeof copy.content], site.key);
        for (const tag of site.accessTags ?? []) assert.ok(copy.access[tag as keyof typeof copy.access], site.key);
      }
    }
  } finally { await server.close(); }
});
