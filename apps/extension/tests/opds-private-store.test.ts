import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { PrivateOpdsStore, type PrivateConnection } from '../src/comics/sources/opds/private-store';

const origin = 'https://catalog.example';

function connection(root: string): PrivateConnection {
  return {
    id: crypto.randomUUID(),
    name: 'Private library',
    root: origin + root,
    origin,
    auth: { kind: 'url-token' },
    revision: 1,
    namespace: 'catalog',
    createdAt: 1,
  };
}

async function saveArtwork(root: string, href: string) {
  const databaseName = `opds-credentials-${crypto.randomUUID()}`;
  const store = new PrivateOpdsStore(databaseName);
  const current = connection(root);
  await store.saveConnection(current);
  await store.saveResources([
    {
      id: 'artwork',
      kind: 'artwork',
      connectionId: current.id,
      revision: current.revision,
      pinned: true,
      updatedAt: 1,
      value: { link: { href: origin + href } },
    },
  ]);
  const savedUrl = async () => {
    const saved = await new PrivateOpdsStore(databaseName).resource('artwork');
    return (saved?.value.link as { href: string }).href;
  };
  return { store, current, savedUrl, databaseName };
}

describe('OPDS credential restoration', () => {
  it.each([false, true])(
    'rebinds a proven path credential used by an image query (disconnect=%s)',
    async (disconnect) => {
      const { store, current, savedUrl } = await saveArtwork(
        '/api/opds/old-secret',
        '/api/image/chapter-cover?chapterId=12&apiKey=old-secret',
      );
      if (disconnect) {
        await store.disconnect(current.id);
        expect(await savedUrl()).not.toContain('old-secret');
        expect(JSON.stringify(await store.connection(current.id))).not.toContain('old-secret');
      }
      const previous = await store.connection(current.id);
      await store.saveConnection(
        { ...current, root: origin + '/api/opds/new-secret', revision: previous!.revision + 1 },
        previous,
      );
      expect(await savedUrl()).toBe(
        origin + '/api/image/chapter-cover?chapterId=12&apiKey=new-secret',
      );
    },
  );

  it('restores query-based authorization without changing an unrelated resource parameter', async () => {
    const { store, current, savedUrl } = await saveArtwork(
      '/opds?token=old-secret',
      '/cover?token=old-secret&book=12',
    );
    await store.disconnect(current.id);
    const previous = await store.connection(current.id);
    await store.saveConnection(
      { ...current, root: origin + '/opds?token=new-secret', revision: previous!.revision + 1 },
      previous,
    );
    expect(await savedUrl()).toBe(origin + '/cover?token=new-secret&book=12');
  });

  it('does not guess that a different image credential belongs to the root path', async () => {
    const { store, current, savedUrl } = await saveArtwork(
      '/api/opds/old-secret',
      '/api/image/chapter-cover?apiKey=other-secret',
    );
    await store.disconnect(current.id);
    expect(await savedUrl()).toBe('opds-unavailable:credential-refresh');
    const previous = await store.connection(current.id);
    await store.saveConnection(
      { ...current, root: origin + '/api/opds/new-secret', revision: previous!.revision + 1 },
      previous,
    );
    expect(await savedUrl()).toBe('opds-unavailable:credential-refresh');
  });

  it('compares decoded token values but preserves correct path and query escaping', async () => {
    const { store, current, savedUrl } = await saveArtwork(
      '/library/api/opds/old%2Bsecret',
      '/library/api/image/chapter-cover?apiKey=old%2Bsecret',
    );
    await store.disconnect(current.id);
    const previous = await store.connection(current.id);
    await store.saveConnection(
      {
        ...current,
        root: origin + '/library/api/opds/new%2Bsecret',
        revision: previous!.revision + 1,
      },
      previous,
    );
    expect(await savedUrl()).toBe(origin + '/library/api/image/chapter-cover?apiKey=new%2Bsecret');
  });

  it('replaces only the known path segment, not a matching reverse-proxy prefix', async () => {
    const { store, current, savedUrl } = await saveArtwork(
      '/old-secret/api/opds/old-secret',
      '/old-secret/api/opds/old-secret/cover',
    );
    await store.disconnect(current.id);
    const previous = await store.connection(current.id);
    await store.saveConnection(
      {
        ...current,
        root: origin + '/old-secret/api/opds/new-secret',
        revision: previous!.revision + 1,
      },
      previous,
    );
    expect(await savedUrl()).toBe(origin + '/old-secret/api/opds/new-secret/cover');
  });

  it('never reconstructs expiring signed artwork during credential restoration', async () => {
    const { store, current, savedUrl } = await saveArtwork(
      '/api/opds/old-secret',
      '/api/image/chapter-cover?apiKey=old-secret&signature=private-signature',
    );
    await store.disconnect(current.id);
    expect(await savedUrl()).toBe('opds-unavailable:expired-signature');
  });

  it.each([
    ['/api/opds/old-secret', '/api/opds/other-secret/cover', '/api/opds/new-secret'],
    ['/opds?token=old-secret', '/cover?token=other-secret', '/opds?token=new-secret'],
  ])('rejects unrelated credentials for root %s', async (root, href, replacement) => {
    for (const disconnect of [false, true]) {
      const { store, current, savedUrl } = await saveArtwork(root, href);
      if (disconnect) {
        await store.disconnect(current.id);
        expect(await savedUrl()).toBe('opds-unavailable:credential-refresh');
      }
      const previous = await store.connection(current.id);
      await store.saveConnection(
        { ...current, root: origin + replacement, revision: previous!.revision + 1 },
        previous,
      );
      expect(await savedUrl()).toBe('opds-unavailable:credential-refresh');
    }
  });

  it.each([
    ['/api/opds/old-secret', '/api/opds/old-secret/cover'],
    ['/api/opds/old-secret', '/api/image/cover?apiKey=old-secret'],
    ['/opds?token=old-secret', '/cover?token=old-secret'],
  ])('keeps proven bindings when disconnect is repeated for %s', async (root, href) => {
    const { store, current, savedUrl } = await saveArtwork(root, href);
    await store.disconnect(current.id);
    await store.disconnect(current.id);
    expect(await savedUrl()).not.toContain('old-secret');
    const previous = await store.connection(current.id);
    await store.saveConnection(
      {
        ...current,
        root: origin + root.replace('old-secret', 'new-secret'),
        revision: previous!.revision + 1,
      },
      previous,
    );
    expect(await savedUrl()).toBe(origin + href.replace('old-secret', 'new-secret'));
  });

  it('does not restore legacy placeholders that did not prove their credential binding', async () => {
    const { store, current, savedUrl } = await saveArtwork(
      '/api/opds/old-secret',
      '/api/opds/__opds_credential__/cover',
    );
    await store.disconnect(current.id);
    const previous = await store.connection(current.id);
    await store.saveConnection(
      { ...current, root: origin + '/api/opds/new-secret', revision: previous!.revision + 1 },
      previous,
    );
    expect(await savedUrl()).toBe('opds-unavailable:credential-refresh');
  });
});
