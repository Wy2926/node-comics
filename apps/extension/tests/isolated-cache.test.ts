import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ByteCache } from '../src/storage/cache';

const makeCache = (budgetBytes = 12, retained = false) => new ByteCache({ name: 'test-' + crypto.randomUUID(), budgetBytes, retained });
const blob = (size: number) => new Blob([new Uint8Array(size)]);

describe('independent byte stores', () => {
  it('adopts import ranges without copying bytes and cleans them up with their final owner', async () => {
    const cache = makeCache();
    await cache.put('index', blob(6), {owner: 'pending', connectionId: 'cloud', contentId: 'temporary'});
    const writes = vi.spyOn(IDBObjectStore.prototype, 'put');
    await cache.adoptOwner('pending', 'entry', 'content');
    expect(writes.mock.calls.every(([value]) => !(value instanceof Blob))).toBe(true);
    writes.mockRestore();
    await cache.deleteOwner('pending', true);
    expect((await cache.get('index'))?.size).toBe(6);
    expect(await cache.usage()).toMatchObject({bytes: 6, count: 1});
    await cache.deleteRevision('temporary');
    expect(await cache.has('index')).toBe(true);
    await cache.deleteOwner('entry', true);
    expect(await cache.usage()).toMatchObject({bytes: 0, count: 0});
  });
  it.each(['clear', 'source', 'target'])('does not revive cache data after %s during import adoption', async action => {
    const cache = makeCache();
    await cache.put('index', blob(6), {owner: 'pending'});
    if (action === 'clear') await cache.clear();
    else await cache.deleteOwner(action === 'source' ? 'pending' : 'entry', true);
    await cache.adoptOwner('pending', 'entry', 'content');
    await cache.deleteOwner('pending', true);
    expect(await cache.has('index')).toBe(false);
    expect(await cache.usage()).toMatchObject({bytes: 0, count: 0});
  });
  it('accounts concurrent reservations transactionally so multiple tabs cannot overspend', async () => {
    const first = makeCache(), second = new ByteCache({ name: first.name, budgetBytes: 12 });
    const reservations = await Promise.all([first.reserve('a', 8), second.reserve('b', 8)]);
    expect(reservations.filter(Boolean)).toHaveLength(1);
    expect(await first.usage()).toMatchObject({ bytes: 0, reservedBytes: 8, count: 0 });
    const reservation = reservations.find(value => value)!;
    expect(await first.commit(reservation, blob(8))).toBe(true);
    expect(await second.usage()).toMatchObject({ bytes: 8, reservedBytes: 0, count: 1 });
  });
  it('never exposes incomplete writes and rejects the wrong byte length', async () => {
    const cache = makeCache(), reservation = (await cache.reserve('page', 8))!;
    expect(await cache.get('page')).toBeUndefined();
    expect(await cache.commit(reservation, blob(7))).toBe(false);
    expect(await cache.usage()).toMatchObject({ bytes: 0, reservedBytes: 0 });
  });
  it('uses metadata LRU and does not rewrite bytes on cache hits or scan Blobs for totals', async () => {
    const cache = makeCache(); const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1); await cache.put('first', blob(4));
    now.mockReturnValue(2); await cache.put('second', blob(4));
    now.mockReturnValue(3); await cache.get('first');
    now.mockReturnValue(4); await cache.put('third', blob(8));
    expect(await cache.get('second')).toBeUndefined();
    expect(await cache.get('first')).toBeInstanceOf(Blob);
    const scan = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    expect(await cache.usage()).toMatchObject({ bytes: 12, count: 2 });
    expect(scan).not.toHaveBeenCalled(); scan.mockRestore(); now.mockRestore();
  });
  it('clears source pages without changing translated or explicitly downloaded bytes', async () => {
    const pages = makeCache(), translations = makeCache(), downloads = makeCache(0, true);
    await pages.put('page', blob(6)); await translations.put('result', blob(6)); await downloads.put('saved', blob(100));
    await pages.clear(); await downloads.trim(1000);
    expect(await pages.usage()).toMatchObject({ bytes: 0, count: 0 });
    expect((await translations.get('result'))?.size).toBe(6);
    expect((await downloads.get('saved'))?.size).toBe(100);
  });
  it('fences late network responses and already reserved writes after clear or owner deletion', async () => {
    const cache = makeCache(), token = await cache.token('revision');
    const pending = (await cache.reserve('early', 3, { owner: 'revision', token }))!;
    await cache.clear();
    expect(await cache.commit(pending, blob(3))).toBe(false);
    expect(await cache.put('late', blob(3), { owner: 'revision', token })).toBe(false);
    const nextToken = await cache.token('revision');
    await cache.deleteOwner('revision', true);
    expect(await cache.put('removed', blob(3), { owner: 'revision', token: nextToken })).toBe(false);
    await cache.allowOwner('revision');
    expect(await cache.put('fresh', blob(3), { owner: 'revision', token: await cache.token('revision') })).toBe(true);
  });
  it('fences only the deleted key across contexts, including old tokens and already reserved writes',async()=>{
    const first=makeCache(100),second=new ByteCache({name:first.name,budgetBytes:100}),token=await first.token('account');
    const removed=(await first.reserve('removed',3,{owner:'account',token}))!,unrelated=(await first.reserve('unrelated',3,{owner:'account',token}))!;
    const otherToken=await first.token('other-channel');
    await second.delete('removed');
    expect(await first.commit(removed,blob(3))).toBe(false);
    expect(await first.put('removed',blob(3),{owner:'account',token})).toBe(false);
    expect(await first.commit(unrelated,blob(3))).toBe(true);
    expect(await first.put('another-page',blob(3),{owner:'account',token})).toBe(true);
    expect(await first.put('another-channel',blob(3),{owner:'other-channel',token:otherToken})).toBe(true);
    expect(await second.usage()).toMatchObject({bytes:9,reservedBytes:0,count:3});
    expect(await first.put('removed',blob(3),{owner:'account',token:await second.token('account')})).toBe(true);
  });
  it('keeps fresh tokens valid when another key is deleted and discards key fences on clear',async()=>{
    const cache=makeCache(100),initial=await cache.token('account');await cache.delete('a');
    const afterA=await cache.token('account');await cache.delete('b');
    expect(await cache.put('a',blob(3),{owner:'account',token:afterA})).toBe(true);
    expect(await cache.put('b',blob(3),{owner:'account',token:afterA})).toBe(false);
    await cache.clear();
    expect(await cache.token('account','a')).toMatchObject({keyEpoch:0,keyGeneration:0});
    expect(await cache.put('a',blob(3),{owner:'account',token:initial})).toBe(false);
    expect(await cache.put('a',blob(3),{owner:'account',token:await cache.token('account')})).toBe(true);
  });
  it('preserves tokens and reservations stored before key fence metadata was introduced',async()=>{
    const cache=makeCache(100),captured=await cache.token('account'),token={epoch:captured.epoch,ownerGeneration:captured.ownerGeneration,owner:captured.owner};
    const reservation=(await cache.reserve('legacy-reservation',3,{owner:'account',token}))!;
    const {sourceDatabaseName}=await import('../src/storage/database');
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const opening=indexedDB.open(sourceDatabaseName(cache.name));opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error);});
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('reservations','readwrite'),legacy={...reservation};delete legacy.keyEpoch;tx.objectStore('reservations').put(legacy);
      tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);
    });db.close();
    expect(await cache.commit(reservation,blob(3))).toBe(true);
    expect(await cache.put('legacy-token',blob(3),{owner:'account',token})).toBe(true);
    await cache.delete('removed');
    expect(await cache.put('removed',blob(3),{owner:'account',token})).toBe(false);
    expect(await cache.put('legacy-token',blob(3),{owner:'account',token})).toBe(true);
  });
  it('uses single-record key checks without adding scans or transactions to cache publication',async()=>{
    const cache=makeCache(100,true),get=IDBObjectStore.prototype.get,put=IDBObjectStore.prototype.put;
    let reads=0,writes=0;
    const read=vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['get']>){if(this.name==='state')reads++;return get.apply(this,args);});
    const write=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){if(this.name==='state')writes++;return put.apply(this,args);});
    try{
      const token=await cache.token('account');expect(reads).toBe(2);
      reads=0;await cache.token('account','page');expect(reads).toBe(3);
      reads=0;const reservation=(await cache.reserve('page',3,{owner:'account',token}))!;expect(reads).toBe(3);
      reads=0;expect(await cache.commit(reservation,blob(3))).toBe(true);expect(reads).toBe(3);
      reads=0;writes=0;await cache.delete('page');expect(reads).toBe(1);expect(writes).toBe(2);
    }finally{read.mockRestore();write.mockRestore();}
  });
  it('respects a budget disabled while a response is in flight and preserves memory results', async () => {
    const cache = makeCache(), reservation = (await cache.reserve('pending', 8))!, bytes = blob(8);
    await cache.setBudget(0);
    expect(await cache.commit(reservation, bytes)).toBe(false);
    expect(await cache.put('uncached', bytes)).toBe(false);
    expect(bytes.size).toBe(8);
    expect(await cache.usage()).toMatchObject({ bytes: 0, reservedBytes: 0 });
  });
  it('keeps old cache entries when a single new page is larger than its entire budget', async () => {
    const cache = makeCache(); await cache.put('previous', blob(8));
    expect(await cache.put('too-big', blob(13))).toBe(false);
    expect((await cache.get('previous'))?.size).toBe(8);
  });
  it('expires abandoned reservations in bounded recovery while preserving live ones', async () => {
    const cache = makeCache(), now = vi.spyOn(Date, 'now'); now.mockReturnValue(100);
    const abandoned = (await cache.reserve('abandoned', 8))!;
    now.mockReturnValue(60_101);
    const current = (await cache.reserve('current', 8))!;
    expect(current).toBeDefined();
    expect(await cache.commit(abandoned, blob(8))).toBe(false);
    expect(await cache.commit(current, blob(8))).toBe(true); now.mockRestore();
  });
});
