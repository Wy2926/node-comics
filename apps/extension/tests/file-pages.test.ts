import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api } from '../src/api';
import { mergeJobs } from '../src/reader/jobs';
import type { FilePageMatch, FilePageSource, Job } from '../src/types';

const origin = 'https://api.example';
const source = (index: number): FilePageSource => ({ file_hash: index.toString(16).padStart(64, '0'), page_index: 0 });
const match = (page: FilePageSource): FilePageMatch => ({ ...page, asset: { id: 'asset', width: 100, height: 200, expires_at: null }, translations: [] });
const job = (status: Job['status'], extra: Partial<Job> = {}): Job => ({ id: 'job', input_asset_id: 'asset', output_asset_id: status === 'succeeded' ? 'result' : null, mode: 'classic', target_language: 'zh-Hans', status, phase: '', quota_pages: 1, created_at: '2026-09-14T00:00:00Z', version: 1, cache_hit: false, ...extra });
afterEach(() => vi.unstubAllGlobals());

describe('optional public file-page API contract', () => {
  it('validates paired file fields without requiring file identities for normal reading', async () => {
    const page = source(1), calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { calls.push(init); return Response.json({ items: [match(page)] }); });
    const api = new Api(origin, 'token'); await api.matchPages([page], 'classic', 'zh-Hans');
    expect(JSON.parse(calls[0].body as string)).toEqual({ pages: [page], mode: 'classic', target_language: 'zh-Hans', include_display: true });
    await expect(api.matchPages([{ file_hash: page.file_hash, page_index: undefined as never }], 'classic', 'zh-Hans')).rejects.toThrow('成对');
  });
  it('rejects oversized or reordered responses', async () => {
    const api = new Api(origin), first = source(1), second = source(2);
    await expect(api.matchPages(Array.from({ length: 101 }, () => first), 'classic', 'zh-Hans')).rejects.toThrow('100');
    vi.stubGlobal('fetch', async () => Response.json({ items: [match(second), match(first)] }));
    await expect(api.matchPages([first, second], 'classic', 'zh-Hans')).rejects.toThrow('不一致');
  });
  it('sends the real image digest only when one is available', async () => {
    const page = { ...source(1), image_sha256: 'b'.repeat(64) }, calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { calls.push(init); return Response.json({ items: [match(page)] }); });
    await new Api(origin).matchPages([page], 'redraw', 'zh-Hans');
    expect(JSON.parse(calls[0].body as string).pages[0].image_sha256).toBe(page.image_sha256);
  });
  it('keeps transfer concurrency independent of account policy', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json({}); });
    const api = new Api(origin); api.pool.setLimit(10); expect(calls).toHaveLength(0); await api.entitlements();
    expect(calls.map(call => [call.url, call.init.method ?? 'GET', call.init.body])).toEqual([[origin + '/v1/me/entitlements', 'GET', undefined]]);
  });
});
describe('translation result versions', () => {
  it('never lets older pending state revive a completed or removed result', () => {
    expect(mergeJobs([job('succeeded')], [job('running')])[0].status).toBe('succeeded');
    expect(mergeJobs([job('outcome_unknown')], [job('queued')])[0].status).toBe('outcome_unknown');
    expect(mergeJobs([job('succeeded', { output_asset_id: null })], [job('succeeded', { output_asset_id: 'stale-result' })])[0]).toMatchObject({ output_asset_id: null, result_available: false, result_expired: true });
  });
  it('applies revoked authorization regardless of execution timestamps and prevents late revival',()=>{
    const revoked=job('failed',{output_asset_id:null,result_expired:true,error:{code:'TRANSLATION_UNAVAILABLE',message:'unavailable'}});
    const merged=mergeJobs([job('succeeded')],[revoked]);expect(merged[0].result_expired).toBe(true);expect(merged[0].output_asset_id).toBeNull();expect(mergeJobs(merged,[job('succeeded')])[0].output_asset_id).toBeNull();
  });
  it('retains independent versions from different configurations', () => {
    const old = job('succeeded', { id: 'old-config', version: 2, created_at: '2026-09-13T00:00:00Z' });
    const newer = job('succeeded', { id: 'new-config', version: 1, created_at: '2026-09-14T00:00:00Z' });
    expect(mergeJobs([old], [newer]).map(item => item.id)).toEqual(['old-config', 'new-config']);
  });
});
