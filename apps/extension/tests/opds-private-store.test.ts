import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  PrivateOpdsStore,
  type PrivateConnection,
  type PrivateResource,
} from '../src/comics/sources/opds/private-store';

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

describe('OPDS resource authorization fence', () => {
  function resource(current: PrivateConnection, id: string, pinned = true): PrivateResource {
    return {
      id,
      kind: 'artwork',
      connectionId: current.id,
      revision: current.revision,
      value: { link: { href: current.root + '/cover' } },
      pinned,
      updatedAt: 1,
    };
  }

  it.each([false, true])('rejects a late resource after disconnect (pinned=%s)', async (pinned) => {
    const databaseName = `opds-late-resource-${crypto.randomUUID()}`;
    const store = new PrivateOpdsStore(databaseName);
    const current = connection('/api/opds/old-secret');
    const original = resource(current, 'artwork', pinned);
    await store.saveConnection(current);
    await store.saveResources([original]);
    await store.disconnect(current.id);
    const sanitized = await store.resource(original.id);

    await expect(store.saveResources([original])).rejects.toMatchObject({ code: 'disconnected' });

    expect(await store.resource(original.id)).toEqual(sanitized);
    expect(await new PrivateOpdsStore(databaseName).resource(original.id)).toEqual(sanitized);
    if (pinned) expect(JSON.stringify(sanitized)).not.toContain('old-secret');
    else expect(sanitized).toBeUndefined();
  });

  it.each([false, true])(
    'does not overwrite resources rebound to a new credential (disconnect=%s)',
    async (disconnect) => {
      const { store, current, savedUrl, databaseName } = await saveArtwork(
        '/api/opds/old-secret',
        '/api/image/chapter-cover?apiKey=old-secret',
      );
      const stale = (await store.resource('artwork'))!;
      if (disconnect) await store.disconnect(current.id);
      const previous = (await store.connection(current.id))!;
      await store.saveConnection(
        { ...current, root: origin + '/api/opds/new-secret', revision: previous.revision + 1 },
        previous,
      );
      const rebound = await store.resource('artwork');

      await expect(store.saveResources([stale])).rejects.toMatchObject({ code: 'disconnected' });

      expect(await store.resource('artwork')).toEqual(rebound);
      expect(await new PrivateOpdsStore(databaseName).resource('artwork')).toEqual(rebound);
      expect(await savedUrl()).toBe(origin + '/api/image/chapter-cover?apiKey=new-secret');
    },
  );

  it('rejects an entire batch before publishing any transient or pinned result', async () => {
    const databaseName = `opds-resource-batch-${crypto.randomUUID()}`;
    const store = new PrivateOpdsStore(databaseName);
    const active = connection('/api/opds/active-secret');
    const missing = connection('/api/opds/missing-secret');
    await store.saveConnection(active);

    await expect(
      store.saveResources([
        resource(active, 'transient', false),
        resource(active, 'pinned'),
        resource(missing, 'missing'),
      ]),
    ).rejects.toMatchObject({ code: 'disconnected' });

    const reopened = new PrivateOpdsStore(databaseName);
    for (const id of ['transient', 'pinned', 'missing']) {
      expect(await store.resource(id)).toBeUndefined();
      expect(await reopened.resource(id)).toBeUndefined();
    }
  });

  it('checks each connection once for a bounded transient batch', async () => {
    const databaseName = `opds-resource-batch-${crypto.randomUUID()}`;
    const store = new PrivateOpdsStore(databaseName);
    const current = connection('/api/opds/current-secret');
    await store.saveConnection(current);
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    try {
      await store.saveResources(
        Array.from({ length: 2001 }, (_, index) => resource(current, `artwork-${index}`, false)),
      );
      const connectionReads = get.mock.contexts.filter(
        (objectStore) => (objectStore as IDBObjectStore).name === 'connections',
      );
      expect(connectionReads).toHaveLength(1);
    } finally {
      get.mockRestore();
    }
    expect(await store.resource('artwork-0')).toBeUndefined();
    expect(await store.resource('artwork-1')).toBeDefined();
    expect(await store.resource('artwork-2000')).toBeDefined();
    expect(await new PrivateOpdsStore(databaseName).resource('artwork-2000')).toBeUndefined();
  });

  it.each([false, true])(
    'clears resources committed before a concurrent disconnect (pinned=%s)',
    async (pinned) => {
      const databaseName = `opds-concurrent-resource-${crypto.randomUUID()}`;
      const store = new PrivateOpdsStore(databaseName);
      const current = connection('/api/opds/old-secret');
      await store.saveConnection(current);

      await Promise.all([
        store.saveResources([resource(current, 'artwork', pinned)]),
        store.disconnect(current.id),
      ]);

      const saved = await store.resource('artwork');
      expect((await store.connection(current.id))?.disconnected).toBe(true);
      expect(saved).toEqual(await new PrivateOpdsStore(databaseName).resource('artwork'));
      if (pinned) expect(JSON.stringify(saved)).not.toContain('old-secret');
      else expect(saved).toBeUndefined();
    },
  );

  it.each([false, true])(
    'serializes disconnect with credential replacement (disconnect first=%s)',
    async (disconnectFirst) => {
      const { store, current, savedUrl } = await saveArtwork(
        '/api/opds/old-secret',
        '/api/image/chapter-cover?apiKey=old-secret',
      );
      const refresh = () =>
        store.saveConnection(
          { ...current, root: origin + '/api/opds/new-secret', revision: 2 },
          current,
        );
      const operations = disconnectFirst
        ? [store.disconnect(current.id), refresh()]
        : [refresh(), store.disconnect(current.id)];
      const results = await Promise.allSettled(operations);
      const disconnected = (await store.connection(current.id))!;

      expect(results[disconnectFirst ? 0 : 1].status).toBe('fulfilled');
      expect(disconnected.disconnected).toBe(true);
      expect(disconnected.revision).toBe(disconnectFirst ? 2 : 3);
      expect(JSON.stringify(await store.resource('artwork'))).not.toContain('secret');
      await store.saveConnection(
        {
          ...current,
          root: origin + '/api/opds/final-secret',
          revision: disconnected.revision + 1,
        },
        disconnected,
      );
      expect(await savedUrl()).toBe(origin + '/api/image/chapter-cover?apiKey=final-secret');
    },
  );
});

describe('explicit OPDS private removal',()=>{
  it('deletes credentials and every indexed resource in bounded batches, preserving another connection',async()=>{
    const databaseName='opds-remove-'+crypto.randomUUID(),store=new PrivateOpdsStore(databaseName);
    const current=connection('/api/opds/private-secret'),other=connection('/api/opds/other-secret');
    await store.saveConnection(current);await store.saveConnection(other);
    const resource=(value:PrivateConnection,id:string,pinned=true):PrivateResource=>({id,connectionId:value.id,revision:1,kind:'artwork',value:{link:{href:value.root+'/cover'}},pinned,updatedAt:1});
    await store.saveResources([
      ...Array.from({length:205},(_,index)=>resource(current,'removed:'+index)),
      resource(current,'transient',false),resource(other,'other'),
    ]);
    const reads=vi.spyOn(IDBIndex.prototype,'getAllKeys');
    await store.remove(current.id);
    const scoped=reads.mock.calls.filter((_,index)=>(reads.mock.contexts[index] as IDBIndex).name==='connectionId');
    expect(scoped).toEqual([[current.id,100],[current.id,100],[current.id,100]]);
    reads.mockRestore();
    const reopened=new PrivateOpdsStore(databaseName);
    expect(await reopened.connection(current.id)).toBeUndefined();
    expect(await store.resource('transient')).toBeUndefined();
    for(let index=0;index<205;index++)expect(await reopened.resource('removed:'+index)).toBeUndefined();
    expect(await reopened.connection(other.id)).toEqual(other);expect(await reopened.resource('other')).toBeDefined();
    await expect(store.saveConnection({...current,revision:2},current)).rejects.toMatchObject({code:'disconnected'});
    await expect(store.saveResources([resource(current,'late')])).rejects.toMatchObject({code:'disconnected'});
    await store.remove(current.id);expect(await reopened.resource('late')).toBeUndefined();
  });

  it.each([true,false])('serializes a credential edit with removal (remove first=%s)',async removeFirst=>{
    const databaseName='opds-remove-race-'+crypto.randomUUID(),store=new PrivateOpdsStore(databaseName),current=connection('/api/opds/private-secret');
    await store.saveConnection(current);
    const edit=()=>store.saveConnection({...current,root:origin+'/api/opds/new-secret',revision:2},current);
    await Promise.allSettled(removeFirst?[store.remove(current.id),edit()]:[edit(),store.remove(current.id)]);
    expect(await store.connection(current.id)).toBeUndefined();
  });

  it('retains the safe directory address of a legacy Basic connection after disconnect',async()=>{
    const store=new PrivateOpdsStore('opds-safe-configuration-'+crypto.randomUUID());
    const current={...connection('/opds?lang=zh'),auth:{kind:'basic' as const,username:'reader',password:'secret'}};
    await store.saveConnection(current);await store.disconnect(current.id);
    expect(await store.connection(current.id)).toMatchObject({root:'',configurationUrl:origin+'/opds?lang=zh',auth:{kind:'basic',username:'',password:''}});
  });
});
