import {Api} from '../api';
import {assertCurrent, mapConcurrent} from '../concurrency';
import type {Chapter, FilePageMatch, FilePageSource, Job, Mode, Page} from '../types';
import {newestFirst,pendingStatuses} from './presentation';

export function pageSource(page: Page): FilePageSource | undefined {
  return page.fileHash && /^[a-f0-9]{64}$/.test(page.fileHash) && Number.isSafeInteger(page.pageIndex) && page.pageIndex! >= 0
    ? {file_hash: page.fileHash, page_index: page.pageIndex!} : undefined;
}
export const sourceKey = (source: FilePageSource) => `${source.file_hash}:${source.page_index}`;
export const reusableJob = (job: Job, mode: Mode, language: string) => job.mode === mode && job.target_language === language &&
  (['queued', 'running', 'outcome_unknown', 'no_text'].includes(job.status) || job.status === 'succeeded' && !!job.output_asset_id);

export function mergeJobs(previous: Job[], incoming: Job[]): Job[] {
  const jobs = new Map(previous.map(job => [job.id, job]));
  const rank = {queued: 0, running: 1, outcome_unknown: 2, failed: 3, cancelled: 3, no_text: 3, succeeded: 4};
  for (const job of incoming) {
    const old = jobs.get(job.id);
    if (!old || rank[job.status] >= rank[old.status]) jobs.set(job.id, job);
  }
  return [...jobs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.version - b.version);
}

export function applyMatch(page: Page, match: FilePageMatch, ownerId: string, apiOrigin: string, snapshot: Page = page): Page {
  const sameOwner = page.ownerId === ownerId && page.apiOrigin === apiOrigin;
  const assetChanged = sameOwner && (page.assetId !== snapshot.assetId || page.assetExpiresAt !== snapshot.assetExpiresAt || page.ownerId !== snapshot.ownerId || page.apiOrigin !== snapshot.apiOrigin);
  return {...page, ownerId, apiOrigin,
    // An earlier chunk's miss must not erase an upload completed while the rest of the book matched.
    assetId: assetChanged ? page.assetId : match.asset?.id,
    assetExpiresAt: assetChanged ? page.assetExpiresAt : match.asset?.expires_at,
    // The local original determines layout; restoring an asset must not move the reading position.
    jobs: mergeJobs(sameOwner ? page.jobs : [], [...match.jobs,...(match.display_jobs??[])]),
    outputBlobs: sameOwner ? page.outputBlobs : {}, operationIds: sameOwner ? page.operationIds : {},
    translationError: sameOwner ? page.translationError : undefined,
  };
}

// Only in-flight matches are shared. A later translation always checks live configuration/expiry.
export interface MatchResult { matches: Map<string, FilePageMatch>; errors: Map<string, Error>; }
export interface RerunSource { pageId: string; jobId: string; inputAssetId: string; }
export function submittedJobsForPage(pageId: string, preparedPages: Page[], returned: Job[], rerun?: RerunSource): Job[] {
  const prepared = preparedPages.find(page => page.id === pageId);
  if (!prepared) return [];
  return returned.filter(job => rerun?.pageId === pageId
    ? job.input_asset_id === rerun.inputAssetId
    : (job.requested_asset_id ?? job.input_asset_id) === prepared.assetId);
}
export function bindSubmission(chapter: Chapter | undefined, preparedPages: Page[], returned: Job[], ownerId: string, apiOrigin: string, rerun?: RerunSource) {
  const attached = new Set<string>();
  const pages = chapter?.pages.map(page => {
    if (page.ownerId !== ownerId || page.apiOrigin !== apiOrigin) return page;
    const jobs = submittedJobsForPage(page.id, preparedPages, returned, rerun);
    jobs.forEach(job => attached.add(job.id));
    return jobs.length ? {...page, jobs: mergeJobs(page.jobs, jobs)} : page;
  });
  return {chapter: chapter && {...chapter, pages: pages!}, detachedJobIds: [...new Set(returned.filter(job => !attached.has(job.id)).map(job => job.id))]};
}
export function rerunSource(page: Page, match: FilePageMatch | undefined, mode: Mode, language: string): RerunSource | undefined {
  if (!match) return;
  if (match.display_jobs) {
    const previous=newestFirst(mergeJobs(page.jobs,[...match.jobs,...match.display_jobs])).find(job=>job.mode===mode&&job.target_language===language);
    return previous&&page.assetId?{pageId:page.id,jobId:previous.id,inputAssetId:page.assetId}:undefined;
  }
  if (!match.asset) return;
  const validInputs = new Set([match.asset.id, ...match.jobs.map(job => job.input_asset_id)]);
  const previous = mergeJobs(page.jobs, match.jobs).filter(job => job.mode === mode && job.target_language === language && validInputs.has(job.input_asset_id)).at(-1);
  return previous ? {pageId: page.id, jobId: previous.id, inputAssetId: previous.input_asset_id} : undefined;
}
export function planTranslation(pages: Page[], result: MatchResult, mode: Mode, language: string, regenerate = false) {
  const selected: Page[] = [];
  const failures: {page: Page; message: string}[] = [];
  for (const page of pages) {
    const source = pageSource(page);
    const match = source && result.matches.get(sourceKey(source));
    const message = !source ? '缺少文件页标识，请重新导入。' : result.errors.get(sourceKey(source))?.message ?? (!match ? '尚未核实此页的服务器记录，请重试恢复。' : undefined);
    if (message) { failures.push({page, message}); continue; }
    if (match?.display_jobs) {
      const visible=newestFirst(match.display_jobs.filter(j=>j.mode===mode&&j.target_language===language));
      if (visible.some(j=>pendingStatuses.has(j.status))) {
        if(regenerate)failures.push({page,message:'此页仍在处理或核实中，请等待当前任务结束。'});
        continue;
      }
      const delivered=visible.find(j=>j.status==='succeeded');
      if(!regenerate&&(delivered&&(delivered.output_asset_id||page.outputBlobs[delivered.id])||visible[0]?.status==='no_text'))continue;
      // A tombstone supersedes older reusable server versions.
      if(delivered&&!delivered.output_asset_id&&!page.outputBlobs[delivered.id]&&!regenerate){selected.push(page);continue;}
    }
    if (!regenerate && match?.jobs.some(job => reusableJob(job, mode, language))) continue;
    selected.push(page);
  }
  return {selected, failures};
}
const matching = new WeakMap<Api, Map<string, Promise<MatchResult>>>();
export function matchFilePages(api: Api, pages: Page[], mode: Mode, language: string): Promise<MatchResult> {
  const sources = [...new Map(pages.flatMap(page => { const source = pageSource(page); return source ? [[sourceKey(source), source] as const] : []; })).values()];
  const key = JSON.stringify([mode, language, sources]);
  let requests = matching.get(api);
  if (!requests) { requests = new Map(); matching.set(api, requests); }
  const existing = requests.get(key);
  if (existing) return existing;
  const request = (async () => {
    const matches = new Map<string, FilePageMatch>();
    const errors = new Map<string, Error>();
    for (let index = 0; index < sources.length; index += 100) {
      assertCurrent(api.isCurrent);
      const chunk = sources.slice(index, index + 100);
      try {
        const {items} = await api.matchPages(chunk, mode, language);
        for (const item of items) matches.set(sourceKey(item), item);
      } catch (error) { for (const source of chunk) errors.set(sourceKey(source), error as Error); }
      assertCurrent(api.isCurrent);
    }
    return {matches, errors};
  })();
  requests.set(key, request);
  void request.finally(() => requests!.delete(key)).catch(() => {});
  return request;
}

export interface UploadCandidate { page: Page; assetId: string; }
/** Failed pages stay retryable; successful pages retain their original selection order. */
export async function uploadPages(api: Api, pages: Page[], ownerId: string, apiOrigin: string, concurrency: number,
  getBlob: (key: string) => Promise<Blob | undefined>, onPage: (page: Page) => void, current = api.isCurrent) {
  const uploads = new Map<string, Promise<{id: string; expires_at: string}>>();
  return mapConcurrent(pages, concurrency, async requested => {
    assertCurrent(current);
    const source = pageSource(requested);
    if (!source) throw Error(`${requested.name} 缺少文件页标识，请重新导入。`);
    const sameOwner = requested.ownerId === ownerId && requested.apiOrigin === apiOrigin;
    let asset = sameOwner && requested.assetId && Date.parse(requested.assetExpiresAt ?? '') > Date.now()
      ? {id: requested.assetId, expires_at: requested.assetExpiresAt!} : undefined;
    if (!asset) {
      let upload = uploads.get(sourceKey(source));
      if (!upload) {
        upload = (async () => {
          if (!requested.blobKey) throw Error(`${requested.name} 原图未获取，请返回来源或重新导入。`);
          const blob = await getBlob(requested.blobKey);
          assertCurrent(current);
          if (!blob) throw Error(`${requested.name} 本地图片已清理，请重新导入。`);
          return api.upload(blob, requested.name, source);
        })();
        uploads.set(sourceKey(source), upload);
      }
      asset = await upload;
    }
    assertCurrent(current);
    const page = {...requested, assetId: asset.id, assetExpiresAt: asset.expires_at, ownerId, apiOrigin,
      jobs: sameOwner ? requested.jobs : [], outputBlobs: sameOwner ? requested.outputBlobs : {}, operationIds: sameOwner ? requested.operationIds : {}, translationError: undefined};
    onPage(page);
    return {page, assetId: asset.id};
  });
}
