import type { Capabilities, Job, Mode, Quote, Usage, User } from './types';
import type { AuthConfig } from './auth/oidc';
export class ApiError extends Error { constructor(message: string, public code = 'NETWORK_ERROR', public status = 0) { super(message); } }
export function submissionRejected(error:unknown){return error instanceof ApiError&&['QUOTE_EXPIRED','QUOTE_CHANGED','INSUFFICIENT_QUOTA','MAX_CREDITS_EXCEEDED','BUDGET_EXCEEDED','ASSET_EXPIRED','ASSET_DELETED','LANGUAGE_UNSUPPORTED','PROVIDER_CAPABILITY_UNSUPPORTED'].includes(error.code);}
export class Api {
  constructor(public base: string, public token = '') { this.base = base.replace(/\/+$/, ''); }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try { response = await fetch(this.base + path, { ...init, headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }); }
    catch { throw new ApiError('暂时连接不到服务。请检查后端地址与网络，原图仍可继续阅读。'); }
    if (!response.ok) { const raw = await response.json().catch(() => ({})); const error = raw.error ?? raw.detail ?? raw; throw new ApiError(typeof error === 'string' ? error : error.message ?? `请求未完成（${response.status}）`, error.code ?? 'REQUEST_FAILED', response.status); }
    if (response.status === 204) return undefined as T;
    return response.json();
  }
  authConfig() { return this.request<AuthConfig>('/v1/auth/config'); }
  login(username: string) { return this.request<{access_token: string; user: User}>('/v1/auth/dev', { method: 'POST', body: JSON.stringify({username}) }); }
  capabilities() { return this.request<Capabilities>('/v1/capabilities'); }
  usage() { return this.request<Usage>('/v1/me/usage'); }
  upload(blob: Blob, name: string) { const body = new FormData(); body.set('image', blob, name); return this.request<{id: string; width: number; height: number; expires_at: string}>('/v1/images', {method:'POST',body}); }
  quote(asset_ids: string[], mode: Mode, target_language: string) { return this.request<Quote>('/v1/quotes', {method:'POST',body: JSON.stringify({asset_ids,mode,target_language})}); }
  batch(quote_id: string, max_credits: number, key: string) { return this.request<{id: string; status: string; jobs: Job[]; total_cost: number}>('/v1/translation-batches', {method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({quote_id,max_credits})}); }
  create(asset_id: string, mode: Mode, target_language: string, key: string) { const body = new FormData(); body.set('asset_id',asset_id); body.set('target_language',target_language); return this.request<Job>(`/v1/translations/${mode}`,{method:'POST',headers:{'Idempotency-Key':key},body}); }
  status(ids: string[]) { return this.request<{items: Job[]}>('/v1/jobs/status', {method:'POST',body:JSON.stringify({ids})}); }
  cancel(id: string) { return this.request<Job>(`/v1/jobs/${encodeURIComponent(id)}/cancel`,{method:'POST'}); }
  rerun(id:string,key:string,quote_id:string,max_credits:number) {return this.request<Job>(`/v1/jobs/${encodeURIComponent(id)}/rerun`,{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({quote_id,max_credits,acknowledge_unknown_cost:true})});}
  async image(id: string) { const access = await this.request<{url: string; expires_at: string}>(`/v1/images/${encodeURIComponent(id)}/access`); const url = new URL(access.url, this.base); if (url.origin !== new URL(this.base).origin) throw new ApiError('图片访问地址不属于当前服务。','INVALID_ASSET_ORIGIN'); const response = await fetch(url, {headers:{Authorization:`Bearer ${this.token}`}}); if (!response.ok) throw new ApiError('图片已过期或无法访问，请保留本地副本或重新上传。','ASSET_EXPIRED',response.status); const blob=await response.blob(); const bitmap=await createImageBitmap(blob); bitmap.close(); return blob; }
  deleteImage(id: string) { return this.request<void>(`/v1/images/${encodeURIComponent(id)}`,{method:'DELETE'}); }
}
