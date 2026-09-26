import {ApiError,type ComicTitleTranslation} from '../../../api';
import {msg} from '../../../i18n/runtime';
import type {SearchFailure} from './types';

export const SEARCH_QUERY_MAX_CODE_POINTS=160;
export function validateSearchQuery(value:string):string {
  const query=value.trim();
  if(!query||[...query].length>SEARCH_QUERY_MAX_CODE_POINTS||/[\p{Cc}\p{Cf}]/u.test(query))throw new ApiError(msg('请输入 1–160 个字符的搜索名称。'),'INVALID_SEARCH_QUERY',422);
  return query;
}
export function titleFailure(error:unknown,now:number):SearchFailure {
  const apiError=error instanceof ApiError?error:undefined;
  const retryAt=apiError?.retryAfterSeconds?now+apiError.retryAfterSeconds*1000:undefined;
  if(apiError?.status===401)return {kind:'login',message:msg('登录后可自动查找名称，也可以手动输入。')};
  if(apiError?.status===429)return {kind:'rate-limit',message:msg('名称查询过于频繁，请稍后重试；也可以手动输入。'),retryAt};
  if(apiError?.status===422)return {kind:'invalid',message:apiError.message};
  return {kind:'unavailable',message:msg('暂时无法获取漫画名称，可以手动输入后搜索。'),retryAt};
}
function wait(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
  signal.throwIfAborted();
  const abort=()=>{clearTimeout(timer);reject(signal.reason??new DOMException('Aborted','AbortError'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  signal.addEventListener('abort',abort,{once:true});
});}
/** Busy/pending gets at most one Retry-After retry. All other failures leave manual search available. */
export async function resolveComicTitle(run:()=>Promise<ComicTitleTranslation>,signal:AbortSignal):Promise<ComicTitleTranslation> {
  for(let attempt=0;attempt<2;attempt++){
    signal.throwIfAborted();
    try{return await run();}
    catch(error){
      signal.throwIfAborted();
      if(attempt||!(error instanceof ApiError)||!['COMIC_TITLE_BUSY','COMIC_TITLE_PENDING'].includes(error.code)||!error.retryAfterSeconds)throw error;
      await wait(error.retryAfterSeconds*1000,signal);
    }
  }
  throw new Error('Unreachable');
}
