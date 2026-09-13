export type Mode = 'redraw';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'no_text' | 'failed' | 'cancelled' | 'outcome_unknown';
export interface Job { id: string; input_asset_id: string; output_asset_id: string | null; mode: Mode; target_language: string; status: JobStatus; phase: string; error?: { code: string; message: string }; cost: number; created_at: string; completed_at?: string; version: number; cache_hit: boolean; }
export interface Page { id: string; name: string; width: number; height: number; blobKey?: string; sourceUrl?: string; fetchError?: string; assetId?: string; assetExpiresAt?: string; ownerId?: string; apiOrigin?:string; jobs: Job[]; outputBlobs: Record<string, string>; operationIds: Record<string, string>; }
export interface Chapter { id: string; title: string; source: string; sourceUrl?: string; createdAt: number; updatedAt: number; pages: Page[]; pageId: string; relativeOffset: number; demo?: boolean; discoveryComplete?: boolean; }
export interface User { id: string; name: string; role: string; }
export interface Capabilities { modes: { id: Mode; label: string; enabled: boolean; unit_cost: number }[]; languages: { id: string; label: string }[]; limits: { max_bytes: number; max_pixels: number; max_dimension: number; max_batch: number }; quota: { balance: number; reserved: number; available: number }; retention_days: number; }
export interface Usage { balance: number; reserved: number; available: number; items: { id: string; job_id: string; kind: string; amount: number; created_at: string }[]; total: number; }
export interface Settings { apiBase: string; language: string; direction: 'ltr' | 'rtl'; layout: 'continuous' | 'single'; fit: 'width' | 'window'; autoTranslate: boolean; autoLimit: number; cacheLimitMb: number; }
export interface Quote { id: string; total_cost: number; unit_cost: number; page_count: number; expires_at: string; config_version: string; }
export const defaults: Settings = { apiBase: 'http://127.0.0.1:18088', language: 'zh-Hans', direction: 'rtl', layout: 'continuous', fit: 'width', autoTranslate: false, autoLimit: 10, cacheLimitMb: 512 };
export const statusLabels: Record<JobStatus, string> = { queued: '排队中', running: '处理中', succeeded: '已完成', no_text: '未检测到文字', failed: '处理失败', cancelled: '已取消', outcome_unknown: '结果待核实' };
export const modeLabels: Record<Mode, string> = { redraw: 'AI 翻译' };
