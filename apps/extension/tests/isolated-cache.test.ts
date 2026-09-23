import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ByteCache } from '../src/storage/cache';

const makeCache = (budgetBytes = 12, retained = false) => new ByteCache({ name: 'test-' + crypto.randomUUID(), budgetBytes, retained });
const blob = (size: number) => new Blob([new Uint8Array(size)]);

describe('independent byte stores', () => {
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
