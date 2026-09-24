import type {BillingStatus,BillingProvider,BillingCatalog} from './billing';
import {msg} from './i18n/runtime';
import type { Capabilities, Entitlements, FilePageMatch, FilePageSource, Mode, Usage, User, UsageSummary, Paginated, FeedbackIssue, FeedbackRecord, TranslationInput, TranslationSnapshot, TranslationBatch } from './types';
import type { AuthConfig } from './auth/oidc';
import {assertCurrent, RequestPool, UPLOAD_CONCURRENCY} from './concurrency';
import type {Authorization} from './auth/session';
export class ApiError extends Error { constructor(message: string, public code = 'NETWORK_ERROR', public status = 0, public resetsAt?:string|null, public retryAfterSeconds?:number, public scope?:string) { super(message); } }
function retryDelay(body:unknown,header:string|null){
  const seconds=typeof body==='number'?body:header&&/^\d+(?:\.\d+)?$/.test(header)?Number(header):header?(Date.parse(header)-Date.now())/1000:NaN;
  return Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds):undefined;
}
export class Api {
  private snapshots=new Map<string,TranslationSnapshot>();
  private readonly updatesPool = new RequestPool(1);
  private readonly controlPool = new RequestPool(2);
  constructor(public base: string, public token = '', public pool = new RequestPool(UPLOAD_CONCURRENCY), public isCurrent = () => true, private authorization?:Authorization) { this.base = base.replace(/\/+$/, ''); }
  private async assertAuthorized(){assertCurrent(this.isCurrent);if(this.authorization)await this.authorization.current();assertCurrent(this.isCurrent);}
  private async authorizedFetch(url:string|URL,init:RequestInit):Promise<Response>{
    for(let attempt=0;attempt<2;attempt++){
      assertCurrent(this.isCurrent);init.signal?.throwIfAborted();
      const token=this.authorization?await this.authorization.token():this.token;
      assertCurrent(this.isCurrent);init.signal?.throwIfAborted();
      const headers=new Headers(init.headers);if(token)headers.set('Authorization',`Bearer ${token}`);
      let response:Response;
      try{response=await fetch(url,{...init,headers,credentials:'omit'});}
      catch{init.signal?.throwIfAborted();throw new ApiError(msg("暂时连接不到服务。请检查网络连接，原图仍可继续阅读。"));}
      await this.assertAuthorized();
      if(response.status!==401||!this.authorization)return response;
      if(attempt===1)await this.authorization.reject(token);
      else await this.authorization.token(token);
    }
    throw new ApiError(msg("登录已过期，请重新登录。"),'AUTH_REQUIRED',401);
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.controlPool.run(() => this.fetchRequest<T>(path, init));
  }
  private async fetchRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    assertCurrent(this.isCurrent);
    const headers=new Headers(init.headers);if(init.body&&!(init.body instanceof FormData)&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
    const response=await this.authorizedFetch(this.base+path,{...init,headers});
    if (!response.ok) { const raw = await response.json().catch(() => ({})); if(response.status===404&&raw.detail==='Not Found')throw new ApiError(msg("当前 API 服务尚未包含此接口，请更新并重启 API 服务后重试。"),'API_ROUTE_MISSING',404); const error = raw.error ?? raw.detail ?? raw; throw new ApiError(typeof error === 'string' ? error : error.message ?? msg("请求未完成（{0}）", {"0": response.status}), error.code ?? 'REQUEST_FAILED', response.status,error.resets_at,retryDelay(error.retry_after_seconds,response.headers.get('Retry-After')),error.scope); }
    if (response.status === 204) return undefined as T;
    const result=await response.json();await this.assertAuthorized();return result;
  }
  authConfig() { return this.request<AuthConfig>('/v1/auth/config'); }
  login(username: string) { return this.request<{access_token: string; expires_in:number; user: User}>('/v1/auth/dev', { method: 'POST', body: JSON.stringify({username}) }); }
  capabilities() { return this.request<Capabilities>('/v1/capabilities'); }
  entitlements() { return this.request<Entitlements>('/v1/me/entitlements'); }
  usage(offset=0) { return this.request<Usage>(`/v1/me/usage?offset=${offset}&limit=20`); }
  usageSummary(days:number,timezone:string) {return this.request<UsageSummary>(`/v1/me/usage/summary?days=${days}&timezone=${encodeURIComponent(timezone)}`);}
  feedback(jobId:string,body:{issues:FeedbackIssue[];comment:string;output_asset_id?:string|null},key:string) {return this.request<FeedbackRecord>(`/v1/translations/${encodeURIComponent(jobId)}/feedback`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});}
  feedbackList(offset=0) {return this.request<Paginated<FeedbackRecord>>(`/v1/me/feedback?offset=${offset}&limit=20`);}
  async matchPages(pages: FilePageSource[], mode: Mode, target_language: string) {
    if (!pages.length || pages.length > 100) throw new ApiError(msg("每次匹配需提供 1–100 页。"), 'INVALID_PAGE_COUNT');
    pages.forEach(validateSource);
    const result = await this.request<{items: FilePageMatch[]}>('/v1/file-pages/match', {method:'POST',body:JSON.stringify({pages,mode,target_language,include_display:true})});
    if (!Array.isArray(result.items) || result.items.length !== pages.length || result.items.some((item, index) => item.file_hash !== pages[index].file_hash || item.page_index !== pages[index].page_index || !Array.isArray(item.translations))) throw new ApiError(msg("服务器匹配结果与请求页标识不一致。"), 'INVALID_MATCH_RESPONSE');
    return result;
  }
  billingCatalog(){return this.request<BillingCatalog>('/v1/billing/catalog');}
  billingStatus(){return this.request<BillingStatus>('/v1/billing/status');}
  startCheckout(priceId:string,provider:BillingProvider){return this.request<{checkout_url:string;trial:boolean;environment:'test'|'live';provider:BillingProvider}>('/v1/billing/checkouts',{method:'POST',body:JSON.stringify({price_id:priceId,provider})});}
  billingPortal(provider:BillingProvider){return this.request<{url:string;provider:BillingProvider}>('/v1/billing/portal',{method:'POST',body:JSON.stringify({provider})});}
  syncBilling(){return this.request<{billing:BillingStatus;entitlements:Entitlements}>('/v1/billing/sync',{method:'POST'});}
  private remember(snapshot:TranslationSnapshot){this.snapshots.set(snapshot.id,snapshot);return snapshot;}
  async translate(id:string,body:TranslationInput){return this.remember(await this.request<TranslationSnapshot>(`/v1/translations/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(body)}));}
  async translation(id:string,signal?:AbortSignal){return this.remember(await this.request<TranslationSnapshot>(`/v1/translations/${encodeURIComponent(id)}`,{signal}));}
  async translations(ids:string[],options:{etag?:string;wait?:boolean;signal?:AbortSignal}={}){
    if(!ids.length||ids.length>32)throw new ApiError('每次读取需提供 1–32 个翻译编号。','INVALID_TRANSLATION_COUNT');
    const query=new URLSearchParams({ids:ids.join(',')});if(options.wait)query.set('wait_seconds','20');
    const fetchSnapshot=async()=>{
      const response=await this.authorizedFetch(this.base+'/v1/translations?'+query,{signal:options.signal,cache:'no-store',headers:options.etag?{'If-None-Match':options.etag}:{}});
      if(response.status===304)return {etag:response.headers.get('ETag')??options.etag,unchanged:true as const};
      if(!response.ok){const raw=await response.json().catch(()=>({})),error=raw.error??{};throw new ApiError(error.message??msg('翻译服务暂不可用'),error.code??'REQUEST_FAILED',response.status,error.resets_at,retryDelay(error.retry_after_seconds,response.headers.get('Retry-After')));}
      const batch=await response.json() as TranslationBatch;await this.assertAuthorized();for(const item of batch.items)this.remember(item);
      return {etag:response.headers.get('ETag')??undefined,unchanged:false as const,...batch};
    };
    return options.wait?this.updatesPool.run(fetchSnapshot):this.controlPool.run(fetchSnapshot);
  }
  async translationInput(id:string,blob:Blob){return this.pool.run(async()=>this.remember(await this.fetchRequest<TranslationSnapshot>(`/v1/translations/${encodeURIComponent(id)}/input`,{method:'PUT',body:blob,headers:{'Content-Type':blob.type||'application/octet-stream'}})));}
  async translationImage(id:string,signal?:AbortSignal):Promise<Blob>{
    for(let attempt=0;attempt<2;attempt++){
      const snapshot=attempt===0&&this.snapshots.get(id)?.result?.download_url?this.snapshots.get(id)!:await this.translation(id,signal);
      const result=snapshot.result;if(snapshot.state!=='succeeded'||!result?.download_url)throw new ApiError(msg('译图已失效'),'TRANSLATION_UNAVAILABLE',410);
      const signed=result.authorization_required!==true,url=new URL(result.download_url,this.base);
      if(url.username||url.password||(signed?url.protocol!=='https:':url.origin!==new URL(this.base).origin))throw new ApiError(msg('图片访问地址无效。'),'INVALID_ASSET_ORIGIN');
      if(attempt===0&&result.download_expires_at&&Date.parse(result.download_expires_at)<=Date.now())continue;
      await this.assertAuthorized();signal?.throwIfAborted();let response:Response;
      try{const init:RequestInit={credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal};response=signed?await fetch(url,init):await this.authorizedFetch(url,init);}
      catch(error){signal?.throwIfAborted();if(attempt===0&&signed)continue;throw error;}
      if(attempt===0&&[401,403].includes(response.status))continue;
      if(!response.ok)throw new ApiError(msg('图片已过期或无法访问，请保留本地副本或重新上传。'),'ASSET_DOWNLOAD_FAILED',response.status);
      const blob=await response.blob(),bitmap=await createImageBitmap(blob);bitmap.close();await this.assertAuthorized();return blob;
    }
    throw new ApiError(msg('图片访问链接已过期，请重试。'),'ASSET_EXPIRED');
  }
  async image(id: string, signal?: AbortSignal): Promise<Blob> {
    // Image access and bytes bypass both pools so recovery never waits for uploads.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const access = await this.fetchRequest<{url: string; expires_at: string|null; authorization_required?: boolean}>(`/v1/images/${encodeURIComponent(id)}/access`, {signal});
      const url = new URL(access.url, this.base);
      const signed = access.authorization_required === false;
      if (url.username || url.password || (signed ? url.protocol !== 'https:' : url.origin !== new URL(this.base).origin)) {
        throw new ApiError(msg("图片访问地址无效。"), 'INVALID_ASSET_ORIGIN');
      }
      const blob = await (async () => {
        await this.assertAuthorized();
        signal?.throwIfAborted();
        // Refresh an expired signature before starting the download.
        if (signed && attempt === 0 && access.expires_at && Date.parse(access.expires_at) <= Date.now()) return null;
        let response: Response;
        try {
          const init:RequestInit={credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal};
          response=signed?await fetch(url,{...init,headers:{}}):await this.authorizedFetch(url,init);
        } catch (error) {
          signal?.throwIfAborted();
          if(!signed)throw error;
          // R2 omits CORS headers for expired signatures, so fetch may reject.
          if (signed && attempt === 0) return null;
          throw new ApiError(msg("暂时无法下载图片，请检查网络或对象存储的跨域配置。"), 'ASSET_DOWNLOAD_FAILED');
        }
        if (signed && attempt === 0 && [401, 403].includes(response.status)) return null;
        if (!response.ok) throw new ApiError(msg("图片已过期或无法访问，请保留本地副本或重新上传。"), 'ASSET_EXPIRED', response.status);
        const result = await response.blob();
        const bitmap = await createImageBitmap(result);
        bitmap.close();
        await this.assertAuthorized();
        return result;
      })();
      if (blob) return blob;
    }
    throw new ApiError(msg("图片访问链接已过期，请重试。"), 'ASSET_EXPIRED');
  }
}
function validateSource(source: FilePageSource) {
  if (!/^[a-f0-9]{64}$/.test(source.file_hash) || !Number.isSafeInteger(source.page_index) || source.page_index < 0) throw new ApiError(msg("文件 SHA-256 与原始页索引必须成对提供。"), 'INVALID_PAGE_SOURCE');
  if(source.image_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(source.image_sha256))throw new ApiError(msg("图片 SHA-256 无效。"),'INVALID_IMAGE_HASH');
}
