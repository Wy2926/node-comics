import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createOpdsProvider } from '../src/comics/sources/opds/provider';
import { PrivateOpdsStore } from '../src/comics/sources/opds/private-store';
import type { SourceConnection } from '../src/comics/domain';
import type { OpenFileSourceContext } from '../src/comics/sources/contracts';
import { installTestXmlParser } from './opds-protocol-dom';
import { startRemoteLibraryUiServer } from './fixtures/remote-library-ui-server';

installTestXmlParser();

describe('remote library UI fixture over real loopback HTTP', () => {
  it('exercises real OPDS discovery, pagination, search, retry, account isolation and PSE PNG reading', async () => {
    const server = await startRemoteLibraryUiServer();
    const provider = createOpdsProvider({ store: new PrivateOpdsStore('remote-ui-' + crypto.randomUUID()) });
    const connected: SourceConnection[] = [];
    try {
      for (const root of ['/opds', '/opds-other']) {
        const account = await provider.connection!.connect!({ name: root, auth: 'anonymous', url: server.origin + root });
        connected.push({ ...account, generation: 1, createdAt: 1, updatedAt: 1 });
      }
      const connection = connected[0];
      const root = await provider.catalog!.browse({ connection });
      expect(root.navigation).toHaveLength(4);
      expect(root.groups).toHaveLength(3);
      const publications = root.groups!.flatMap((group) => group.publications);
      expect(publications).toHaveLength(24);
      expect(publications[0]).toMatchObject({ title: '星灯书店', authors: ['星野绘', '青禾'], formats: ['cbz'] });
      expect(publications[0].summary).toContain('原创测试故事');
      expect(publications.at(-1)).toMatchObject({ readable: false });
      expect(publications.at(-1)!.reason).toBeTruthy();
      const other = await provider.catalog!.browse({ connection: connected[1] });
      expect(other.groups![0].publications[0].id).not.toBe(publications[0].id);
      const all = root.navigation.find((link) => link.title === '全部漫画')!;
      const first = await provider.catalog!.browse({ connection, location: all.location });
      const second = await provider.catalog!.browse({ connection, cursor: first.next });
      expect(first.publications).toHaveLength(12);
      expect(second.publications).toHaveLength(12);
      expect(new Set([...first.publications, ...second.publications].map((item) => item.id)).size).toBe(24);
      expect(second.previous).toBeDefined();
      const adventure = root.navigation.find((link) => link.title === '冒险与奇幻')!;
      const shelf = await provider.catalog!.browse({ connection, location: adventure.location });
      const series = await provider.catalog!.browse({ connection, location: shelf.navigation[0].location });
      expect(series.title).toBe('星海系列');
      expect(series.publications).toHaveLength(3);
      const result = await provider.catalog!.browse({ connection, location: root.location, search: '星' });
      expect(result.publications.length).toBeGreaterThan(0);
      expect(result.publications.every((item) => item.title.includes('星'))).toBe(true);
      const empty = await provider.catalog!.browse({ connection, location: root.location, search: '不存在的测试作品' });
      expect(empty.publications).toHaveLength(0);
      const retry = root.navigation.find((link) => link.title === '重试测试')!;
      await expect(provider.catalog!.browse({ connection, location: retry.location })).rejects.toThrow();
      expect((await provider.catalog!.browse({ connection, location: retry.location })).title).toBe('重试成功');
      await expect(provider.artwork!.read(connection, publications[7].artwork!)).rejects.toThrow();
      const artwork = await provider.artwork!.read(connection, publications[0].artwork!);
      expect(new Uint8Array(await artwork.slice(0, 8).arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      const plan = await provider.catalog!.resolve(connection, publications[0].id);
      expect(plan.kind).toBe('pages');
      const context: OpenFileSourceContext = {
        connection, source: { connectionId: connection.id, providerItemId: plan.publication.id, locator: plan.locator, generation: 1, status: 'active' },
        entryId: 'fixture-entry', contentId: 'fixture-content', sourceSnapshot: plan.snapshot, format: plan.format,
      };
      const index = await provider.pages!.index(context);
      expect(index.total).toBe(3);
      const page = await provider.pages!.read(context, { ...index.pages[0], contentId: context.contentId, pageId: 'fixture-page', formatLocator: 'opds' });
      expect(page.type).toBe('image/png');
      expect(page.size).toBeGreaterThan(10000);
      expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(server.requests.some((request) => /\/pages\/0\.png$/.test(request.path) && request.status === 200)).toBe(true);
    } finally {
      for (const account of connected) await provider.connection!.disconnect!(account);
      await server.close();
    }
  });
});
