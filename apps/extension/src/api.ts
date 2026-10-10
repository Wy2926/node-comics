import {msg} from './i18n/runtime';
import type { Capabilities, Entitlements, QuotaPurchases, Usage, User, UsageSummary, Paginated, FeedbackIssue, FeedbackRecord, TranslationInput, TranslationSnapshot, TranslationBatch } from './types';
import type { AuthConfig } from './auth/oidc';
import {assertCurrent, RequestPool, UPLOAD_CONCURRENCY} from './concurrency';
import type {Authorization} from './auth/session';
import {cachedRequest,cacheValue,peekCached} from './api-cache';
import {serverEvents} from './sse';
export class ApiError extends Error { constructor(message: string, public code = 'NETWORK_ERROR', public status = 0, public resetsAt?:string|null, public retryAfterSeconds?:number, public scope?:string) { super(message); } }
export interface ComicTitleTranslation {name:string|null;target_language:string|null}
function retryDelay(body:unknown,header:string|null){
  const seconds=typeof body==='number'?body:header&&/^\d+(?:\.\d+)?$/.test(header)?Number(header):header?(Date.parse(header)-Date.now())/1000:NaN;
  return Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds):undefined;
}
export class Api {
  private static snapshots=new Map<string,TranslationSnapshot>();
  private readonly controlPool = new RequestPool(2);
  constructor(public base: string, public token = '', public pool = new RequestPool(UPLOAD_CONCURRENCY), public isCurrent = () => true, private authorization?:Authorization) { this.base = base.replace(/\/+$/, ''); }
  private async assertAuthorized(){assertCurrent(this.isCurrent);if(this.authorization)await this.authorization.current();assertCurrent(this.isCurrent);}
  private async authorizedFetch(url:string|URL,init:RequestInit):Promise<Response>{
    for(let attempt=0;attempt<2;attempt++){
      assertCurrent(this.isCurrent);init.signal?.throwIfAborted();
      const token=this.authorization?await this.authorization.token():this.token;
      assertCurrent(this.isCurrent);init.signal?.throwIfAborted();
      const headers=new Headers(init.headers);if(token)headers.set('Authorization',`Bearer ${token}`);
      if(new URL(url,this.base).pathname.startsWith('/v1/translations'))headers.set('X-Translation-Protocol','overlay-v1');
      let response:Response;
      try{response=await fetch(url,{...init,headers,credentials:'omit'});}
      catch{init.signal?.throwIfAborted();throw new ApiError(msg("暂时连接不到服务。请检查网络连接，原图仍可继续阅读。"));}
      try{await this.assertAuthorized();}catch(error){await response.body?.cancel();throw error;}
      // A redirected asset host cannot invalidate the API session that authorized the initial request.
      if(response.status!==401||!this.authorization||response.url&&new URL(response.url).origin!==new URL(url,this.base).origin)return response;
      await response.body?.cancel();
      if(attempt===1)await this.authorization.reject(token);
      else await this.authorization.token(token);
    }
    throw new ApiError(msg("登录已过期，请重新登录。"),'AUTH_REQUIRED',401);
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const signal=AbortSignal.any([AbortSignal.timeout(30000),...(init.signal?[init.signal]:[])]);
    return this.controlPool.run(() => this.fetchRequest<T>(path, {...init,signal}));
  }
  private async fetchRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    assertCurrent(this.isCurrent);
    const headers=new Headers(init.headers);if(init.body&&!(init.body instanceof FormData)&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
    const response=await this.authorizedFetch(this.base+path,{...init,headers});
    if (!response.ok) { const raw = await response.json().catch(() => ({})); if(response.status===404&&raw.detail==='Not Found')throw new ApiError(msg("当前 API 服务尚未包含此接口，请更新并重启 API 服务后重试。"),'API_ROUTE_MISSING',404); const error = raw.error ?? raw.detail ?? raw; throw new ApiError(typeof error === 'string' ? error : error.message ?? msg("请求未完成（{0}）", {"0": response.status}), error.code ?? 'REQUEST_FAILED', response.status,error.resets_at,retryDelay(error.retry_after_seconds,response.headers.get('Retry-After')),error.scope); }
    if (response.status === 204) return undefined as T;
    const result=await response.json();await this.assertAuthorized();return result;
  }
  private cacheKey(path:string){return JSON.stringify([this.base,this.authorization?.cacheKey??this.token,path]);}
  private async cached<T>(path:string,force=false){await this.assertAuthorized();const value=await cachedRequest(this.cacheKey(path),()=>this.request<T>(path),force);await this.assertAuthorized();return value;}
  rememberEntitlements(value:Entitlements){
    const key=this.cacheKey('/v1/me/entitlements'),previous=peekCached<Entitlements>(key);
    if(previous&&(previous===value||Date.parse(previous.generated_at)>Date.parse(value.generated_at)))return previous;
    cacheValue(key,value);return value;
  }
  authConfig() { return this.cached<AuthConfig>('/v1/auth/config'); }
  login(username: string) { return this.request<{access_token: string; expires_in:number; user: User}>('/v1/auth/dev', { method: 'POST', body: JSON.stringify({username}) }); }
  async capabilities() {
    await this.assertAuthorized();
    const value=await cachedRequest(this.cacheKey('/v1/capabilities'),async()=>{
      const result=await this.request<Capabilities>('/v1/capabilities');
      if(result.result_protocol!=='overlay-v1')throw new ApiError(msg('翻译协议已更新，请更新插件。'),'TRANSLATION_PROTOCOL_MISMATCH',409);
      if(result.entitlements)this.rememberEntitlements(result.entitlements);
      return result;
    });
    await this.assertAuthorized();return {...value,modes:value.modes.filter(mode=>mode.id==='classic'),entitlements:peekCached<Entitlements>(this.cacheKey('/v1/me/entitlements'))??value.entitlements};
  }
  async translateComicTitle(name:string,targetLanguage:string,signal?:AbortSignal):Promise<ComicTitleTranslation> {
    const title=name.trim();
    if(!title||[...title].length>60||/[\p{Cc}\p{Cf}]/u.test(title))throw new ApiError(msg('漫画名称需为 1–60 个字符，且不能包含控制字符。'),'INVALID_COMIC_TITLE',422);
    const result=await this.request<ComicTitleTranslation>('/v1/comic-titles/translate',{method:'POST',body:JSON.stringify({name:title,target_language:targetLanguage}),signal});
    if(!result||!((result.name===null&&result.target_language===null)||(typeof result.name==='string'&&!!result.name.trim()&&typeof result.target_language==='string'&&!!result.target_language.trim())))throw new ApiError(msg('名称服务返回了无效结果，请手动输入搜索名称。'),'INVALID_COMIC_TITLE_RESPONSE');
    return result;
  }
  entitlements(force=false) { return this.cached<Entitlements>('/v1/me/entitlements',force); }
  quotaPurchases(cursor:string|null=null,signal?:AbortSignal) { return this.request<QuotaPurchases>(`/v1/me/quota-purchases?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{signal}); }
  usage(offset=0) { return this.request<Usage>(`/v1/me/usage?offset=${offset}&limit=20`); }
  usageSummary(days:number,timezone:string,force=false) {return this.cached<UsageSummary>(`/v1/me/usage/summary?days=${days}&timezone=${encodeURIComponent(timezone)}`,force);}
  feedback(jobId:string,body:{issues:FeedbackIssue[];comment:string;},key:string) {return this.request<FeedbackRecord>(`/v1/translations/${encodeURIComponent(jobId)}/feedback`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});}
  feedbackList(offset=0) {return this.request<Paginated<FeedbackRecord>>(`/v1/me/feedback?offset=${offset}&limit=20`);}
  private snapshotKey(id:string){return this.cacheKey('/v1/translations/'+id);}
  private remember(snapshot:TranslationSnapshot){
    const key=this.snapshotKey(snapshot.id);Api.snapshots.delete(key);Api.snapshots.set(key,snapshot);
    if(Api.snapshots.size>128)Api.snapshots.delete(Api.snapshots.keys().next().value!);
    return snapshot;
  }
  async translate(id:string,body:TranslationInput){
    if('image' in body&&body.mode!=='classic')throw new ApiError(msg('翻译服务暂不可用'),'TRANSLATION_MODE_UNAVAILABLE',410);
    return this.remember(await this.request<TranslationSnapshot>(`/v1/translations/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(body)}));
  }
  async translation(id:string,signal?:AbortSignal){return this.remember(await this.request<TranslationSnapshot>(`/v1/translations/${encodeURIComponent(id)}`,{signal}));}
  async translations(ids:string[],options:{etag?:string;signal?:AbortSignal}={}){
    if(!ids.length||ids.length>32)throw new ApiError('每次读取需提供 1–32 个翻译编号。','INVALID_TRANSLATION_COUNT');
    const query=new URLSearchParams({ids:ids.join(',')}),signal=AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]);
    const fetchSnapshot=async()=>{
      const response=await this.authorizedFetch(this.base+'/v1/translations?'+query,{signal,cache:'no-store',headers:options.etag?{'If-None-Match':options.etag}:{}});
      if(response.status===304)return {etag:response.headers.get('ETag')??options.etag,unchanged:true as const};
      if(!response.ok){const raw=await response.json().catch(()=>({})),error=raw.error??{};throw new ApiError(error.message??msg('翻译服务暂不可用'),error.code??'REQUEST_FAILED',response.status,error.resets_at,retryDelay(error.retry_after_seconds,response.headers.get('Retry-After')));}
      const batch=await response.json() as TranslationBatch;await this.assertAuthorized();for(const item of batch.items)this.remember(item);
      return {etag:response.headers.get('ETag')??undefined,unchanged:false as const,...batch};
    };
    return this.controlPool.run(fetchSnapshot);
  }
  async *translationEvents(ids:string[],signal:AbortSignal):AsyncGenerator<TranslationBatch>{
    if(!ids.length||ids.length>32)throw new ApiError('每次读取需提供 1–32 个翻译编号。','INVALID_TRANSLATION_COUNT');
    const response=await this.authorizedFetch(this.base+'/v1/translations/events?'+new URLSearchParams({ids:ids.join(',')}),{signal,cache:'no-store',headers:{Accept:'text/event-stream'}});
    if(!response.ok){const raw=await response.json().catch(()=>({})),error=raw.error??raw.detail??{};throw new ApiError(error.message??msg('翻译服务暂不可用'),error.code??'REQUEST_FAILED',response.status,error.resets_at,retryDelay(error.retry_after_seconds,response.headers.get('Retry-After')));}
    if(!response.body||!response.headers.get('Content-Type')?.startsWith('text/event-stream')){await response.body?.cancel();throw new ApiError(msg('翻译服务暂不可用'),'INVALID_EVENT_STREAM');}
    let ended=false;
    for await(const frame of serverEvents(response.body,signal)){
      await this.assertAuthorized();signal.throwIfAborted();
      if(frame.event==='end'){ended=true;break;}
      if(frame.event!=='snapshot')continue;
      const batch=JSON.parse(frame.data) as TranslationBatch;
      if(!Array.isArray(batch.items)||!Array.isArray(batch.missing_ids)||batch.items.some(item=>!ids.includes(item.id))||batch.missing_ids.some(id=>!ids.includes(id)))throw new ApiError(msg('翻译服务暂不可用'),'INVALID_EVENT_STREAM');
      for(const item of batch.items)this.remember(item);
      yield batch;
    }
    if(!ended&&!signal.aborted)throw new ApiError(msg('翻译服务暂不可用'),'EVENT_STREAM_CLOSED');
  }
  async translationInput(id:string,blob:Blob){
    return this.pool.run(async()=>this.remember(await this.fetchRequest<TranslationSnapshot>(`/v1/translations/${encodeURIComponent(id)}/input`,{method:'PUT',body:blob,headers:{'Content-Type':blob.type||'application/octet-stream'}})));
  }
  async translationImage(id:string,signal?:AbortSignal):Promise<Blob>{
    const snapshot=Api.snapshots.get(this.snapshotKey(id))??await this.translation(id,signal);
    const result=snapshot.result,artifact=result?.artifact;
    if(snapshot.state!=='succeeded'||!result||!artifact||result.representation==='original')throw new ApiError(msg('译图已失效'),'TRANSLATION_UNAVAILABLE',410);
    const expected=`/v1/translations/${encodeURIComponent(id)}/result`;
    if(artifact.path!==expected)throw new ApiError(msg('图片访问地址无效。'),'INVALID_ASSET_ORIGIN');
    const url=new URL(artifact.path,this.base);
    if(url.origin!==new URL(this.base).origin||url.username||url.password)throw new ApiError(msg('图片访问地址无效。'),'INVALID_ASSET_ORIGIN');
    const response=await this.authorizedFetch(url,{credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'follow',signal});
    if(!response.ok)throw new ApiError(msg('图片已过期或无法访问，请保留本地副本或重新上传。'),'ASSET_DOWNLOAD_FAILED',response.status);
    const blob=await response.blob();await this.assertAuthorized();signal?.throwIfAborted();return blob;
  }
}
