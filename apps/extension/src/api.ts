import type { Capabilities, Entitlements, FilePageMatch, FilePageSource, Job, Mode, Usage, User, UploadPlan, TranslationChanges, UsageSummary, Paginated, FeedbackIssue, FeedbackRecord, TranslationPlan, PlanReceipt, TranslationOperation, ReadingPriority } from './types';
import type { AuthConfig } from './auth/oidc';
import {assertCurrent, RequestPool, UPLOAD_CONCURRENCY} from './concurrency';
export class ApiError extends Error { constructor(message: string, public code = 'NETWORK_ERROR', public status = 0, public resetsAt?:string|null, public retryAfterSeconds?:number, public scope?:string) { super(message); } }
function retryDelay(body:unknown,header:string|null){
  const seconds=typeof body==='number'?body:header&&/^\d+(?:\.\d+)?$/.test(header)?Number(header):header?(Date.parse(header)-Date.now())/1000:NaN;
  return Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds):undefined;
}
export class Api {
  private readonly updatesPool = new RequestPool(1);
  private readonly controlPool = new RequestPool(2);
  constructor(public base: string, public token = '', public pool = new RequestPool(UPLOAD_CONCURRENCY), public isCurrent = () => true) { this.base = base.replace(/\/+$/, ''); }
  async request<T>(path: string, init: RequestInit = {}, allowPlanLimit=false): Promise<T> {
    return this.controlPool.run(() => this.fetchRequest<T>(path, init, allowPlanLimit));
  }
  private async fetchRequest<T>(path: string, init: RequestInit = {}, allowPlanLimit=false): Promise<T> {
    assertCurrent(this.isCurrent);
    let response: Response;
    try { response = await fetch(this.base + path, { ...init, headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }); }
    catch { init.signal?.throwIfAborted();throw new ApiError('暂时连接不到服务。请检查后端地址与网络，原图仍可继续阅读。'); }
    if (!response.ok) { const raw = await response.json().catch(() => ({})); if(allowPlanLimit&&response.status===429&&Array.isArray(raw.items)&&(raw.error?.code==='IMAGE_RATE_LIMITED'||raw.items.every((item:TranslationOperation)=>item.code==='IMAGE_RATE_LIMITED')))return raw as T; if(response.status===404&&raw.detail==='Not Found')throw new ApiError('当前 API 服务尚未包含此接口，请更新并重启 API 服务后重试。','API_ROUTE_MISSING',404); const error = raw.error ?? raw.detail ?? raw; throw new ApiError(typeof error === 'string' ? error : error.message ?? `请求未完成（${response.status}）`, error.code ?? 'REQUEST_FAILED', response.status,error.resets_at,retryDelay(error.retry_after_seconds,response.headers.get('Retry-After')),error.scope); }
    if (response.status === 204) return undefined as T;
    return response.json();
  }
  authConfig() { return this.request<AuthConfig>('/v1/auth/config'); }
  login(username: string) { return this.request<{access_token: string; user: User}>('/v1/auth/dev', { method: 'POST', body: JSON.stringify({username}) }); }
  capabilities() { return this.request<Capabilities>('/v1/capabilities'); }
  entitlements() { return this.request<Entitlements>('/v1/me/entitlements'); }
  billingStatus() { return this.request<import('./types').BillingStatus>('/v1/billing/status'); }
  billingCheckout() { return this.request<{checkout_url:string;trial:boolean;environment:string}>('/v1/billing/checkouts',{method:'POST'}); }
  billingSync() { return this.request<{billing:import('./types').BillingStatus;entitlements:Entitlements}>('/v1/billing/sync',{method:'POST'}); }
  billingCancel() { return this.request<import('./types').BillingStatus>('/v1/billing/cancel',{method:'POST'}); }
  billingPortal() { return this.request<{url:string}>('/v1/billing/portal',{method:'POST'}); }
  usage(offset=0) { return this.request<Usage>(`/v1/me/usage?offset=${offset}&limit=20`); }
  usageSummary(days:number,timezone:string) {return this.request<UsageSummary>(`/v1/me/usage/summary?days=${days}&timezone=${encodeURIComponent(timezone)}`);}
  operations(offset=0) {return this.request<Paginated<TranslationOperation>>(`/v1/translation-operations?offset=${offset}&limit=12`);}
  latestResult(jobId:string) {return this.request<{latest:Job|null;result:Job|null}>(`/v1/jobs/${encodeURIComponent(jobId)}/latest-result`);}
  feedback(jobId:string,body:{issues:FeedbackIssue[];comment:string;output_asset_id?:string|null},key:string) {return this.request<FeedbackRecord>(`/v1/jobs/${encodeURIComponent(jobId)}/feedback`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});}
  feedbackList(admin=false,offset=0) {return this.request<Paginated<FeedbackRecord>>(`/v1/${admin?'admin':'me'}/feedback?offset=${offset}&limit=20`);}
  reviewFeedback(id:string,status:FeedbackRecord['status']) {return this.request<FeedbackRecord>(`/v1/admin/feedback/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({status})});}
  async matchPages(pages: FilePageSource[], mode: Mode, target_language: string) {
    if (!pages.length || pages.length > 100) throw new ApiError('每次匹配需提供 1–100 页。', 'INVALID_PAGE_COUNT');
    pages.forEach(validateSource);
    const result = await this.request<{items: FilePageMatch[]}>('/v1/file-pages/match', {method:'POST',body:JSON.stringify({pages,mode,target_language,include_display:true})});
    if (!Array.isArray(result.items) || result.items.length !== pages.length || result.items.some((item, index) => item.file_hash !== pages[index].file_hash || item.page_index !== pages[index].page_index || !Array.isArray(item.jobs))) throw new ApiError('服务器匹配结果与请求页标识不一致。', 'INVALID_MATCH_RESPONSE');
    return result;
  }
  status(ids: string[]) { return this.request<{items: Job[]}>('/v1/jobs/status', {method:'POST',body:JSON.stringify({ids})}); }
  cancel(id: string) { return this.request<Job>(`/v1/jobs/${encodeURIComponent(id)}/cancel`,{method:'POST'}); }
  plan(body:TranslationPlan) {return this.request<PlanReceipt>('/v1/translation-plans',{method:'POST',body:JSON.stringify(body)},true);}
  resolveOperations(operation_keys:string[]) {return this.request<{items:TranslationOperation[];policy_revision?:string}>('/v1/translation-operations/resolve',{method:'POST',body:JSON.stringify({operation_keys})});}
  lease(sessionId:string,modes:Mode[],priority_epochs:Partial<Record<Mode,number>>,takeover=false) {return this.request<{session_id:string;priority:Partial<Record<Mode,ReadingPriority>>;policy_revision:string}>(`/v1/reading-sessions/${encodeURIComponent(sessionId)}/lease`,{method:'PUT',body:JSON.stringify({modes,priority_epochs,takeover})});}
  completeUpload(id:string) {return this.request<Job>(`/v1/uploads/${encodeURIComponent(id)}/complete`,{method:'POST'});}
  translationChanges(cursor?:string,policyRevision?:string) {const query=new URLSearchParams();if(cursor)query.set('cursor',cursor);if(policyRevision)query.set('policy_revision',policyRevision);return this.request<TranslationChanges>(`/v1/me/translation-changes?${query}`);}
  waitForTranslationChanges(cursor:string|undefined,signal:AbortSignal,policyRevision?:string) {
    // A waiting connection must not consume upload/image request capacity.
    const listener=new Api(this.base,this.token,this.updatesPool,this.isCurrent);
    return this.updatesPool.run(()=>listener.request<TranslationChanges>(`/v1/me/translation-changes?cursor=${encodeURIComponent(cursor??'0')}&wait_seconds=20${policyRevision?'&policy_revision='+encodeURIComponent(policyRevision):''}`,{signal}));
  }
  async uploadOriginal(plan:UploadPlan,blob:Blob) {
    const url=new URL(plan.url,this.base),origin=new URL(this.base).origin,local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(url.username||url.password||url.protocol!=='https:'&&!(local&&url.protocol==='http:')||plan.method!=='PUT'||plan.authorization_required&&url.origin!==origin)throw new ApiError('原图上传授权地址无效。','INVALID_UPLOAD_PLAN');
    if(Date.parse(plan.expires_at)<=Date.now())throw new ApiError('上传授权已到期，请刷新后继续。','UPLOAD_URL_EXPIRED');
    return this.pool.run(async()=>{
      assertCurrent(this.isCurrent);
      let response:Response;
      try {response=await fetch(url,{method:'PUT',body:blob,headers:{...plan.headers,...(plan.authorization_required?{Authorization:`Bearer ${this.token}`}:{})},credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});}
      catch {throw new ApiError('原图上传暂未完成，请检查网络和对象存储跨域配置。','UPLOAD_FAILED');}
      if(!response.ok)throw new ApiError('原图上传未完成，将刷新上传授权后重试。','UPLOAD_FAILED',response.status);
      assertCurrent(this.isCurrent);
    });
  }
  async image(id: string, signal?: AbortSignal): Promise<Blob> {
    // Image access and bytes bypass both pools so recovery never waits for uploads.
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const access = await this.fetchRequest<{url: string; expires_at: string|null; authorization_required?: boolean}>(`/v1/images/${encodeURIComponent(id)}/access`, {signal});
      const url = new URL(access.url, this.base);
      const signed = access.authorization_required === false;
      if (url.username || url.password || (signed ? url.protocol !== 'https:' : url.origin !== new URL(this.base).origin)) {
        throw new ApiError('图片访问地址无效。', 'INVALID_ASSET_ORIGIN');
      }
      const blob = await (async () => {
        assertCurrent(this.isCurrent);
        signal?.throwIfAborted();
        // Refresh an expired signature before starting the download.
        if (signed && attempt === 0 && access.expires_at && Date.parse(access.expires_at) <= Date.now()) return null;
        let response: Response;
        try {
          response = await fetch(url, {
            headers: signed ? {} : {Authorization: `Bearer ${this.token}`},
            credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal,
          });
        } catch {
          signal?.throwIfAborted();
          // R2 omits CORS headers for expired signatures, so fetch may reject.
          if (signed && attempt === 0) return null;
          throw new ApiError('暂时无法下载图片，请检查网络或对象存储的跨域配置。', 'ASSET_DOWNLOAD_FAILED');
        }
        if (signed && attempt === 0 && [401, 403].includes(response.status)) return null;
        if (!response.ok) throw new ApiError('图片已过期或无法访问，请保留本地副本或重新上传。', 'ASSET_EXPIRED', response.status);
        const result = await response.blob();
        const bitmap = await createImageBitmap(result);
        bitmap.close();
        assertCurrent(this.isCurrent);
        return result;
      })();
      if (blob) return blob;
    }
    throw new ApiError('图片访问链接已过期，请重试。', 'ASSET_EXPIRED');
  }
  deleteImage(id: string) { return this.request<void>(`/v1/images/${encodeURIComponent(id)}`,{method:'DELETE'}); }
}
function validateSource(source: FilePageSource) {
  if (!/^[a-f0-9]{64}$/.test(source.file_hash) || !Number.isSafeInteger(source.page_index) || source.page_index < 0) throw new ApiError('文件 SHA-256 与原始页索引必须成对提供。', 'INVALID_PAGE_SOURCE');
  if(source.image_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(source.image_sha256))throw new ApiError('图片 SHA-256 无效。','INVALID_IMAGE_HASH');
}
