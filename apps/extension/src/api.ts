import type { Capabilities, Entitlements, FilePageMatch, FilePageSource, Job, Mode, Usage, User, ModeQueue, SubmissionInput, SubmissionReceipt, UploadPlan, TranslationChanges, QueuePriority, PriorityReceipt, UsageSummary, SubmissionSummary, Paginated, FeedbackIssue, FeedbackRecord } from './types';
import type { AuthConfig } from './auth/oidc';
import {assertCurrent, RequestPool} from './concurrency';
export class ApiError extends Error { constructor(message: string, public code = 'NETWORK_ERROR', public status = 0, public resetsAt?:string|null, public retryAfterSeconds?:number) { super(message); } }
function retryDelay(body:unknown,header:string|null){
  const seconds=typeof body==='number'?body:header&&/^\d+(?:\.\d+)?$/.test(header)?Number(header):header?(Date.parse(header)-Date.now())/1000:NaN;
  return Number.isFinite(seconds)&&seconds>0?Math.ceil(seconds):undefined;
}
export function submissionRejected(error:unknown){return error instanceof ApiError&&['QUEUE_FULL','READING_UPLOAD_RESERVED','INVALID_BATCH','RERUN_SOURCE_REQUIRED','RERUN_SOURCE_MISMATCH','UNKNOWN_COST_ACK_REQUIRED','IMAGE_TOO_LARGE','IMAGE_HASH_MISMATCH','INVALID_INPUT_ASSET','FILE_PAGE_CONFLICT','QUEUE_CAPACITY_EXCEEDED','INVALID_SUBMISSION','SUBMISSION_TOO_LARGE','DAILY_QUOTA_EXHAUSTED','REDRAW_QUOTA_EXHAUSTED','QUOTA_CONFLICT','QUOTA_BOUND_EXCEEDED','ENTITLEMENT_CHANGED','PLUS_REQUIRED','TOO_MANY_JOBS','ASSET_EXPIRED','ASSET_DELETED','LANGUAGE_UNSUPPORTED','PROVIDER_CAPABILITY_UNSUPPORTED','CLASSIC_NOT_CONFIGURED','CLASSIC_CONFIG_INVALID'].includes(error.code);}
export class Api {
  constructor(public base: string, public token = '', public pool = new RequestPool(), public isCurrent = () => true) { this.base = base.replace(/\/+$/, ''); }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.pool.run(async () => {
    assertCurrent(this.isCurrent);
    let response: Response;
    try { response = await fetch(this.base + path, { ...init, headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }); }
    catch { throw new ApiError('暂时连接不到服务。请检查后端地址与网络，原图仍可继续阅读。'); }
    if (!response.ok) { const raw = await response.json().catch(() => ({})); if(response.status===404&&raw.detail==='Not Found')throw new ApiError('当前 API 服务尚未包含此接口，请更新并重启 API 服务后重试。','API_ROUTE_MISSING',404); const error = raw.error ?? raw.detail ?? raw; throw new ApiError(typeof error === 'string' ? error : error.message ?? `请求未完成（${response.status}）`, error.code ?? 'REQUEST_FAILED', response.status,error.resets_at,retryDelay(error.retry_after_seconds,response.headers.get('Retry-After'))); }
    if (response.status === 204) return undefined as T;
    return response.json();
    });
  }
  authConfig() { return this.request<AuthConfig>('/v1/auth/config'); }
  login(username: string) { return this.request<{access_token: string; user: User}>('/v1/auth/dev', { method: 'POST', body: JSON.stringify({username}) }); }
  capabilities() { return this.request<Capabilities>('/v1/capabilities'); }
  entitlements() { return this.request<Entitlements>('/v1/me/entitlements'); }
  usage(offset=0) { return this.request<Usage>(`/v1/me/usage?offset=${offset}&limit=20`); }
  usageSummary(days:number,timezone:string) {return this.request<UsageSummary>(`/v1/me/usage/summary?days=${days}&timezone=${encodeURIComponent(timezone)}`);}
  history(offset=0) {return this.request<Paginated<SubmissionSummary>>(`/v1/translation-submissions?offset=${offset}&limit=12`);}
  latestResult(jobId:string) {return this.request<{latest:Job|null;result:Job|null}>(`/v1/jobs/${encodeURIComponent(jobId)}/latest-result`);}
  async historyJobs(group:SubmissionSummary,offset=0) {const receipt=await this.submission(group.id);return {items:receipt.items.slice(offset,offset+30).map(item=>({...item.job,reused:!!item.reused})),total:receipt.items.length,next_offset:offset+30<receipt.items.length?offset+30:null};}
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
  queues() {return this.request<{items:ModeQueue[]}>('/v1/me/queues');}
  queueItems(mode:Mode,offset=0) {return this.request<Paginated<Job>>(`/v1/me/queues/${mode}/items?offset=${offset}&limit=100`);}
  submit(body:SubmissionInput,key:string) {return this.request<SubmissionReceipt>('/v1/translation-submissions',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});}
  submission(id:string) {return this.request<SubmissionReceipt>(`/v1/translation-submissions/${encodeURIComponent(id)}`);}
  completeUpload(id:string) {return this.request<Job>(`/v1/uploads/${encodeURIComponent(id)}/complete`,{method:'POST'});}
  translationChanges(cursor?:string) {return this.request<TranslationChanges>(`/v1/me/translation-changes${cursor?'?cursor='+encodeURIComponent(cursor):''}`);}
  priority(mode:Mode,body:QueuePriority) {return this.request<PriorityReceipt>(`/v1/me/queues/${mode}/priority`,{method:'POST',body:JSON.stringify(body)});}
  pauseQueue(mode:Mode,paused:boolean) {return this.request<ModeQueue>(`/v1/me/queues/${mode}/pause`,{method:'POST',body:JSON.stringify({paused})});}
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
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const access = await this.request<{url: string; expires_at: string|null; authorization_required?: boolean}>(`/v1/images/${encodeURIComponent(id)}/access`, {signal});
      const url = new URL(access.url, this.base);
      const signed = access.authorization_required === false;
      if (url.username || url.password || (signed ? url.protocol !== 'https:' : url.origin !== new URL(this.base).origin)) {
        throw new ApiError('图片访问地址无效。', 'INVALID_ASSET_ORIGIN');
      }
      const blob = await this.pool.run(async () => {
        assertCurrent(this.isCurrent);
        signal?.throwIfAborted();
        // Refresh after waiting in the request pool, without nesting pool slots.
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
      });
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
