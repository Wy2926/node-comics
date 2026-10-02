import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {SourceCatalogSnapshot} from '../../../contracts/source';
import {catalogUrl} from '../definition';
import {network, parseCatalog} from '../network';
import {groups, listing, otherTitleId, row, title, titleId} from './fixtures';

beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(0);});
afterEach(() => {vi.useRealTimers();});
const catalogGroups = (total = 101) => Array.from({length: total}, (_, number) => ({chapter_number: number,
  title: 'Chapter ' + number, releases: [row((number + 1).toString(16).padStart(24, '0'), number)]}));
const http429 = () => Object.assign(new Error('MangaBall HTTP 429'), {kind: 'http', details: {status: 429}});

describe('MangaBall progressive catalog', () => {
  it('publishes one reliable readable partial before later pages, then returns the full directory', async () => {
    const all = catalogGroups(), requests: number[] = [], snapshots: SourceCatalogSnapshot[] = [];
    let done = false;
    const pending = network.catalog(catalogUrl(titleId), {
      request: async url => {
        if (url.includes('/detail/')) return JSON.stringify(title(101));
        const page = Number(new URL(url).searchParams.get('page')); requests.push(page);
        return JSON.stringify(listing(all.slice((page - 1) * 100, page * 100), 101, page));
      }, onCatalogProgress: async snapshot => {snapshots.push(snapshot);},
    }).then(value => {done = true; return value;});
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false); expect(requests).toEqual([1]); expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({complete: false, groups: [{complete: false}]});
    expect(snapshots[0].entries).toHaveLength(100); expect(snapshots[0].defaultEntryId).toBeTruthy();
    const first = structuredClone(snapshots[0]);
    await vi.runAllTimersAsync(); const final = await pending;
    expect(final.complete).toBe(true); expect(final.groups.every(group => group.complete)).toBe(true);
    expect(final.entries.map(entry => entry.remoteId)).toEqual(all.map(group => group.releases[0].id));
    expect(snapshots).toEqual([first]); expect(requests).toEqual([1, 2]);
  });
  it('retries only the failed page and does not publish the first partial again after 429 recovery', async () => {
    const all = catalogGroups(), calls: number[] = [], progress = vi.fn(async (_snapshot: SourceCatalogSnapshot) => {});
    const pending = network.catalog(catalogUrl(titleId), {onCatalogProgress: progress, request: async url => {
      if (url.includes('/detail/')) return JSON.stringify(title(101));
      const page = Number(new URL(url).searchParams.get('page')); calls.push(page);
      if (page === 2 && calls.filter(value => value === 2).length === 1) throw http429();
      return JSON.stringify(listing(all.slice((page - 1) * 100, page * 100), 101, page));
    }});
    await vi.advanceTimersByTimeAsync(1000); expect(calls).toEqual([1, 2]); expect(progress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); expect(calls).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1); const final = await pending;
    expect(final.entries).toHaveLength(101); expect(final.complete).toBe(true);
    expect(calls).toEqual([1, 2, 2]); expect(progress).toHaveBeenCalledTimes(1);
  });
  it('waits for the first readable batch without publishing unreadable entries alone', async () => {
    const all = catalogGroups(), snapshots: SourceCatalogSnapshot[] = [];
    for (const group of all.slice(0, 100)) Object.assign(group.releases[0], {status: 'draft'});
    const pending = network.catalog(catalogUrl(titleId), {onCatalogProgress: async snapshot => {snapshots.push(snapshot);}, request: async url => {
      if (url.includes('/detail/')) return JSON.stringify(title(101));
      const page = Number(new URL(url).searchParams.get('page'));
      return JSON.stringify(listing(all.slice((page - 1) * 100, page * 100), 101, page));
    }});
    await vi.advanceTimersByTimeAsync(500); expect(snapshots).toEqual([]);
    await vi.runAllTimersAsync(); expect((await pending).complete).toBe(true);
    expect(snapshots).toHaveLength(1); expect(snapshots[0].entries).toHaveLength(101);
    expect(snapshots[0].entries.filter(entry => entry.readable !== false)).toHaveLength(1);
  });
  it('rejects foreign ownership before publishing a partial or requesting a later page', async () => {
    const all = catalogGroups(); all[0].releases[0].title_id = otherTitleId;
    const progress = vi.fn(), fetcher = vi.fn(async (url: string) => JSON.stringify(url.includes('/detail/') ? title(101) : listing(all.slice(0, 100), 101)));
    const failed = expect(network.catalog(catalogUrl(titleId), {request: fetcher, onCatalogProgress: progress})).rejects.toThrow('归属');
    await vi.runAllTimersAsync(); await failed;
    expect(progress).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps previous and published snapshots when later 429 recovery is exhausted', async () => {
    const all = catalogGroups(), previous = parseCatalog(title(), groups(), titleId), before = structuredClone(previous);
    const error = http429(), calls: number[] = [], progress = vi.fn(async (_snapshot: SourceCatalogSnapshot) => {});
    const failed = expect(network.catalog(catalogUrl(titleId), {previous, onCatalogProgress: progress, request: async url => {
      if (url.includes('/detail/')) return JSON.stringify(title(101));
      const page = Number(new URL(url).searchParams.get('page')); calls.push(page);
      if (page === 2) throw error;
      return JSON.stringify(listing(all.slice(0, 100), 101));
    }})).rejects.toBe(error);
    await vi.runAllTimersAsync(); await failed;
    expect(calls).toEqual([1, 2, 2, 2, 2]); expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0][0].complete).toBe(false); expect(previous).toEqual(before);
  });
  it('awaits the progress consumer and stops pagination if it fails', async () => {
    const all = catalogGroups(), error = new Error('progress consumer failed');
    const progress = vi.fn(async () => {throw error;});
    const fetcher = vi.fn(async (url: string) => JSON.stringify(url.includes('/detail/') ? title(101) : listing(all.slice(0, 100), 101)));
    const failed = expect(network.catalog(catalogUrl(titleId), {request: fetcher, onCatalogProgress: progress})).rejects.toBe(error);
    await vi.runAllTimersAsync(); await failed;
    expect(progress).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('validates partial groups and total budgets while retaining complete-only count checks', () => {
    const all = catalogGroups(), partial = parseCatalog(title(101), all.slice(0, 100), titleId, false);
    expect(partial.complete).toBe(false); expect(partial.groups[0].complete).toBe(false);
    expect(() => parseCatalog(title(101), all.slice(0, 100), titleId)).toThrow('总数');
    expect(() => parseCatalog(title(99), all.slice(0, 100), titleId, false)).toThrow('总数');
    expect(() => parseCatalog(title(10001), Array(10001).fill(all[0]), titleId, false)).toThrow('10000');
    expect(() => parseCatalog(title(1), [{chapter_number: 0, releases: Array(10001).fill(all[0].releases[0])}], titleId, false)).toThrow('10000');
  });
});
