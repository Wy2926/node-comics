import {Api} from '../api';
import {assertCurrent} from '../concurrency';
import type {FilePageMatch, FilePageSource, Job, Mode, Page} from '../types';
import {mergeJobs,newestFirst,pendingStatuses} from './jobs';

export function pageSource(page: Page): FilePageSource | undefined {
  return page.fileHash && /^[a-f0-9]{64}$/.test(page.fileHash) && Number.isSafeInteger(page.pageIndex) && page.pageIndex! >= 0
    ? {file_hash: page.fileHash, page_index: page.pageIndex!, ...(page.imageSha256?{image_sha256:page.imageSha256}:{})} : undefined;
}
export const sourceKey = (source: FilePageSource) => `${source.file_hash}:${source.page_index}`;
export const reusableJob = (job: Job, mode: Mode, language: string) => job.mode === mode && job.target_language === language &&
  (['awaiting_upload','validating_upload','queued', 'running', 'outcome_unknown', 'no_text'].includes(job.status) || job.status === 'succeeded' && !!job.output_asset_id);

export function applyMatch(page: Page, match: FilePageMatch, ownerId: string, apiOrigin: string, snapshot: Page = page): Page {
  const sameOwner = page.ownerId === ownerId && page.apiOrigin === apiOrigin;
  const assetChanged = sameOwner && (page.assetId !== snapshot.assetId || page.assetExpiresAt !== snapshot.assetExpiresAt || page.ownerId !== snapshot.ownerId || page.apiOrigin !== snapshot.apiOrigin);
  return {...page, ownerId, apiOrigin,imageSha256:page.imageSha256??match.asset?.sha256,imageByteSize:match.asset?.byte_size??page.imageByteSize,imageMime:match.asset?.mime??page.imageMime,
    // An earlier chunk's miss must not erase an upload completed while the rest of the book matched.
    assetId: assetChanged ? page.assetId : match.asset?.id,
    assetExpiresAt: assetChanged ? page.assetExpiresAt : match.asset?.expires_at,
    // The local original determines layout; restoring an asset must not move the reading position.
    jobs: mergeJobs(sameOwner ? page.jobs : [], [...match.jobs,...(match.display_jobs??[])]),
    outputBlobs: sameOwner ? page.outputBlobs : {},
    translationError: sameOwner ? page.translationError : undefined,
  };
}

// Only in-flight matches are shared. A later translation always checks live configuration/expiry.
export interface MatchResult { matches: Map<string, FilePageMatch>; errors: Map<string, Error>; }
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
    if(!regenerate&&match?.jobs.some(job=>job.status==='unknown_released')){failures.push({page,message:'原请求可能已产生费用，请使用单页重新翻译并明确确认。'});continue;}
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
