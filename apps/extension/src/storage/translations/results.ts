import { assertCurrent } from '../../concurrency';
import { msg } from '../../i18n/runtime';
import type { Job } from '../../types';
import { translationCache } from './index';
import { SourceDatabaseSchemaError } from '../database';

interface ResultRequest {
  origin: string;
  userId: string;
  job: Job;
  download: () => Promise<Blob>;
  isCurrent: () => boolean;
}
const memory = new Map<string,Blob>();
export function resultInMemory(key:string){return memory.get(key);}
function retainResult(key:string,blob:Blob){memory.delete(key);memory.set(key,blob);let size=[...memory.values()].reduce((n,b)=>n+b.size,0);while(memory.size>1&&(memory.size>4||size>96*1024*1024)){const oldest=memory.keys().next().value!;size-=memory.get(oldest)!.size;memory.delete(oldest);}}
const downloads = new Map<string, Promise<Blob>>();
function cacheUnavailable(error:unknown):undefined{if(error instanceof SourceDatabaseSchemaError)throw error;return undefined;}
export const resultBlobKey = (origin: string, userId: string, job: Job) =>
  'result:' + JSON.stringify([origin, userId, job.id, job.output_asset_id]);

/** Shared bytes, independent of display lifetimes. Web Locks also coalesce across extension contexts. */
export async function loadResultBlob(request: ResultRequest): Promise<Blob> {
  const { origin, userId, job, download, isCurrent } = request;
  assertCurrent(isCurrent);
  if (job.status !== 'succeeded' || !job.output_asset_id || job.result_expired || job.result_available === false)
    throw Error(msg('图片已过期或无法访问，请保留本地副本或重新上传。'));
  const key = resultBlobKey(origin, userId, job);
  let pending = downloads.get(key);
  if (!pending) {
    const read = async () => {
      assertCurrent(isCurrent);
      const token = await translationCache.token(origin+':'+userId).catch(cacheUnavailable);
      const cached = await translationCache.get(key).catch(cacheUnavailable);
      const blob = cached ?? await download();
      assertCurrent(isCurrent);
      if (!cached && token) await translationCache.put(key, blob, {owner: origin+':'+userId, token}).catch(cacheUnavailable);
      retainResult(key,blob);
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
