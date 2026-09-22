import { assertCurrent } from '../concurrency';
import { msg } from '../i18n/runtime';
import type { Job } from '../types';
import { enforceCacheBudget, getBlob, putBlob, readCopies } from './store';

interface ResultRequest {
  origin: string;
  userId: string;
  job: Job;
  download: () => Promise<Blob>;
  isCurrent: () => boolean;
  cacheLimitMb?: number;
}
const downloads = new Map<string, Promise<Blob>>();
export const resultBlobKey = (origin: string, userId: string, job: Job) =>
  'result:' + JSON.stringify([origin, userId, job.id, job.output_asset_id]);

/** Shared bytes, independent of display lifetimes. Web Locks also coalesce across extension contexts. */
export async function loadResultBlob(request: ResultRequest): Promise<Blob> {
  const { origin, userId, job, download, isCurrent, cacheLimitMb } = request;
  assertCurrent(isCurrent);
  if (job.status !== 'succeeded' || !job.output_asset_id || job.result_expired || job.result_available === false)
    throw Error(msg('图片已过期或无法访问，请保留本地副本或重新上传。'));
  const key = resultBlobKey(origin, userId, job);
  let pending = downloads.get(key);
  if (!pending) {
    const read = async () => {
      assertCurrent(isCurrent);
      const cached = await getBlob(key);
      const blob = cached ?? await download();
      assertCurrent(isCurrent);
      // Refresh recency on cache hits as well as new downloads.
      await putBlob(key, blob);
      if (!cached && cacheLimitMb !== undefined && cacheLimitMb >= 0)
        await enforceCacheBudget(await readCopies(), cacheLimitMb);
      return blob;
    };
    pending = (async () => typeof navigator !== 'undefined' && navigator.locks
      ? await navigator.locks.request('nc-result:' + key, read)
      : await read())();
    downloads.set(key, pending);
    void pending.finally(() => { if (downloads.get(key) === pending) downloads.delete(key); }).catch(() => {});
  }
  const blob = await pending;
  assertCurrent(isCurrent);
  return blob;
}
