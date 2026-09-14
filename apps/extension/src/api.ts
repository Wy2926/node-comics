import type { Capabilities, FilePageMatch, FilePageSource, ImageAsset, Job, Mode, Quote, Usage, User, UserQueue, UsageSummary, HistoryGroup, Paginated, FeedbackIssue, FeedbackRecord } from './types';
import type { AuthConfig } from './auth/oidc';
import {assertCurrent, RequestPool} from './concurrency';
export class ApiError extends Error { constructor(message: string, public code = 'NETWORK_ERROR', public status = 0) { super(message); } }
export function submissionRejected(error:unknown){return error instanceof ApiError&&['QUOTE_EXPIRED','QUOTE_CHANGED','INSUFFICIENT_QUOTA','MAX_CREDITS_EXCEEDED','BUDGET_EXCEEDED','ASSET_EXPIRED','ASSET_DELETED','LANGUAGE_UNSUPPORTED','PROVIDER_CAPABILITY_UNSUPPORTED','CLASSIC_NOT_CONFIGURED','CLASSIC_CONFIG_INVALID'].includes(error.code);}
export class Api {
  constructor(public base: string, public token = '', public pool = new RequestPool(), public isCurrent = () => true) { this.base = base.replace(/\/+$/, ''); }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.pool.run(async () => {
    assertCurrent(this.isCurrent);
    let response: Response;
    try { response = await fetch(this.base + path, { ...init, headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }); }
    catch { throw new ApiError('暂时连接不到服务。请检查后端地址与网络，原图仍可继续阅读。'); }
    if (!response.ok) { const raw = await response.json().catch(() => ({})); if(response.status===404&&raw.detail==='Not Found')throw new ApiError('当前 API 服务尚未包含此接口，请更新并重启 API 服务后重试。','API_ROUTE_MISSING',404); const error = raw.error ?? raw.detail ?? raw; throw new ApiError(typeof error === 'string' ? error : error.message ?? `请求未完成（${response.status}）`, error.code ?? 'REQUEST_FAILED', response.status); }
    if (response.status === 204) return undefined as T;
    return response.json();
    });
  }
  authConfig() { return this.request<AuthConfig>('/v1/auth/config'); }
  login(username: string) { return this.request<{access_token: string; user: User}>('/v1/auth/dev', { method: 'POST', body: JSON.stringify({username}) }); }
  capabilities() { return this.request<Capabilities>('/v1/capabilities'); }
  usage(offset=0) { return this.request<Usage>(`/v1/me/usage?offset=${offset}&limit=20`); }
  usageSummary(days:number,timezone:string) {return this.request<UsageSummary>(`/v1/me/usage/summary?days=${days}&timezone=${encodeURIComponent(timezone)}`);}
  history(offset=0) {return this.request<Paginated<HistoryGroup>>(`/v1/translation-history?offset=${offset}&limit=12`);}
  latestResult(jobId:string) {return this.request<{latest:Job|null;result:Job|null}>(`/v1/jobs/${encodeURIComponent(jobId)}/latest-result`);}
  historyJobs(group:HistoryGroup,offset=0) {return group.kind==='batch'?this.request<Paginated<Job>>(`/v1/translation-batches/${encodeURIComponent(group.id)}?offset=${offset}&limit=30`):this.request<Job>(`/v1/jobs/${encodeURIComponent(group.id)}`).then(job=>({items:[job],total:1,next_offset:null}));}
  feedback(jobId:string,body:{issues:FeedbackIssue[];comment:string;output_asset_id?:string|null},key:string) {return this.request<FeedbackRecord>(`/v1/jobs/${encodeURIComponent(jobId)}/feedback`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});}
  feedbackList(admin=false,offset=0) {return this.request<Paginated<FeedbackRecord>>(`/v1/${admin?'admin':'me'}/feedback?offset=${offset}&limit=20`);}
  reviewFeedback(id:string,status:FeedbackRecord['status']) {return this.request<FeedbackRecord>(`/v1/admin/feedback/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({status})});}
  upload(blob: Blob, name: string, source?: FilePageSource) { const body = new FormData(); body.set('image', blob, name); if (source) { validateSource(source); body.set('file_hash', source.file_hash); body.set('page_index', String(source.page_index)); } return this.request<ImageAsset>('/v1/images', {method:'POST',body}); }
  async matchPages(pages: FilePageSource[], mode: Mode, target_language: string) {
    if (!pages.length || pages.length > 100) throw new ApiError('每次匹配需提供 1–100 页。', 'INVALID_PAGE_COUNT');
    pages.forEach(validateSource);
    const result = await this.request<{items: FilePageMatch[]}>('/v1/file-pages/match', {method:'POST',body:JSON.stringify({pages,mode,target_language,include_display:true})});
    if (!Array.isArray(result.items) || result.items.length !== pages.length || result.items.some((item, index) => item.file_hash !== pages[index].file_hash || item.page_index !== pages[index].page_index || !Array.isArray(item.jobs))) throw new ApiError('服务器匹配结果与请求页标识不一致。', 'INVALID_MATCH_RESPONSE');
    return result;
  }
  queue() { return this.request<UserQueue>('/v1/me/queue'); }
  updateQueue(concurrency: number | null) { return this.request<UserQueue>('/v1/me/queue', {method:'PUT',body:JSON.stringify({concurrency})}); }
  quote(asset_ids: string[], mode: Mode, target_language: string) { return this.request<Quote>('/v1/quotes', {method:'POST',body: JSON.stringify({asset_ids,mode,target_language})}); }
  batch(quote_id: string, max_credits: number, key: string) { return this.request<{id: string; status: string; jobs: Job[]; total_cost: number}>('/v1/translation-batches', {method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({quote_id,max_credits})}); }
  create(asset_id: string, mode: Mode, target_language: string, key: string) { const body = new FormData(); body.set('asset_id',asset_id); body.set('target_language',target_language); return this.request<Job>(`/v1/translations/${mode}`,{method:'POST',headers:{'Idempotency-Key':key},body}); }
  status(ids: string[]) { return this.request<{items: Job[]}>('/v1/jobs/status', {method:'POST',body:JSON.stringify({ids})}); }
  cancel(id: string) { return this.request<Job>(`/v1/jobs/${encodeURIComponent(id)}/cancel`,{method:'POST'}); }
  rerun(id:string,key:string,quote_id:string,max_credits:number,input_asset_id?:string) {return this.request<Job>(`/v1/jobs/${encodeURIComponent(id)}/rerun`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({quote_id,max_credits,...(input_asset_id?{input_asset_id}:{})})});}
  async image(id: string) { const access = await this.request<{url: string; expires_at: string}>(`/v1/images/${encodeURIComponent(id)}/access`); const url = new URL(access.url, this.base); if (url.origin !== new URL(this.base).origin) throw new ApiError('图片访问地址不属于当前服务。','INVALID_ASSET_ORIGIN'); return this.pool.run(async()=>{assertCurrent(this.isCurrent);const response = await fetch(url, {headers:{Authorization:`Bearer ${this.token}`}}); if (!response.ok) throw new ApiError('图片已过期或无法访问，请保留本地副本或重新上传。','ASSET_EXPIRED',response.status); const blob=await response.blob(); const bitmap=await createImageBitmap(blob); bitmap.close(); return blob;}); }
  deleteImage(id: string) { return this.request<void>(`/v1/images/${encodeURIComponent(id)}`,{method:'DELETE'}); }
}
function validateSource(source: FilePageSource) {
  if (!/^[a-f0-9]{64}$/.test(source.file_hash) || !Number.isSafeInteger(source.page_index) || source.page_index < 0) throw new ApiError('文件 SHA-256 与原始页索引必须成对提供。', 'INVALID_PAGE_SOURCE');
  if(source.image_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(source.image_sha256))throw new ApiError('图片 SHA-256 无效。','INVALID_IMAGE_HASH');
}
