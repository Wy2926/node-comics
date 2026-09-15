export type Mode = 'redraw' | 'classic';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'no_text' | 'failed' | 'cancelled' | 'outcome_unknown';
export interface Job { id: string; input_asset_id: string; requested_asset_id?: string | null; output_asset_id: string | null; mode: Mode; target_language: string; status: JobStatus; phase: string; error?: { code: string; message: string }; cost: number; created_at: string; completed_at?: string; version: number; cache_hit: boolean; reused?:boolean; quality_flags?: string[]; result_available?: boolean; result_expired?: boolean; settlement?: 'reserved'|'settled'|'released'|'free'; batch_id?:string|null; ordinal?:number; cancel_requested?:boolean; }
export interface FilePageSource { file_hash: string; page_index: number; image_sha256?: string; }
export interface ImageAsset { id: string; width: number; height: number; expires_at: string; }
export interface FilePageMatch extends FilePageSource { asset: ImageAsset | null; jobs: Job[]; display_jobs?: Job[]; }
export interface UserQueue { concurrency: number | null; effective_concurrency: number; default_concurrency: number; max_concurrency: number; queued: number; dispatched: number; running: number; }
export interface Page { id: string; name: string; width: number; height: number; fileHash?: string; pageIndex?: number; imageSha256?: string; blobKey?: string; sourceUrl?: string; fetchError?: string; translationError?: string; assetId?: string; assetExpiresAt?: string; ownerId?: string; apiOrigin?:string; jobs: Job[]; outputBlobs: Record<string, string>; operationIds: Record<string, string>; }
export interface ReadingCopy { id: string; title: string; source: string; sourceKey: string; sourceUrl?: string; sourceEntryId?: string; sourcePagesEdited?:boolean; webImports?:{key:string;pageIds:string[]}[]; manifestRevision: number; retention: 'cache'|'offline'; language?: string; versionId?: string; createdAt: number; updatedAt: number; lastReadAt?:number; coverPageId?:string; pages: Page[]; pageId: string; relativeOffset: number; demo?: boolean; discoveryComplete: boolean; knownTotal?: number; }
export interface User { id: string; name: string; role: string; }
export interface Capabilities { modes: { id: Mode; label: string; enabled: boolean; unit_cost: number }[]; languages: { id: string; label: string }[]; limits: { max_bytes: number; max_pixels: number; max_dimension: number; max_batch: number }; quota: { balance: number; reserved: number; available: number }; retention_days: number; }
export interface Usage { balance: number; reserved: number; available: number; items: { id: string; job_id: string|null; kind: string; amount: number; created_at: string; note?:string }[]; total: number; next_offset?:number|null; }
export interface Settings { apiBase: string; language: string; translationMode: Mode; direction: 'ltr' | 'rtl'; layout: 'continuous' | 'single'; fit: 'width' | 'window'; autoAhead: number; cacheLimitMb: number; requestConcurrency: number; autoShowTranslation:boolean; appearance:'system'|'light'|'dark'; accentTheme:'sky'|'rose'|'mint'|'iris'; libraryLayout:'grid'|'list'; readerBackground:'gray'|'paper'|'night'; textScale:number; }
export interface Quote { id: string; total_cost: number; unit_cost: number; page_count: number; expires_at: string; config_version: string; }
export const defaults: Settings = { apiBase: 'http://127.0.0.1:18088', language: 'zh-Hans', translationMode: 'classic', direction: 'rtl', layout: 'continuous', fit: 'width', autoAhead: 10, cacheLimitMb: 512, requestConcurrency: 2, autoShowTranslation:true, appearance:'system',accentTheme:'sky',libraryLayout:'grid',readerBackground:'gray',textScale:1 };

export interface UsageSummary {balance:number;reserved:number;available:number;timezone:string;start_date:string;end_date:string;generated_at:string;settled:number;delivered:number;free_delivered:number;by_mode:Record<string,number>;days:{date:string;settled:number;classic:number;redraw:number;unclassified:number}[];}
export interface HistoryGroup {id:string;kind:'batch'|'job';created_at:string;mode:Mode;target_language:string;page_count:number;counts:Record<string,number>;settled:number;reserved:number;reused:number;job_ids:string[];asset_ids:string[];}
export interface Paginated<T>{items:T[];total:number;next_offset:number|null;}
export type FeedbackIssue='missing_text'|'meaning'|'typesetting'|'art_changed'|'other';
export interface FeedbackRecord {id:string;job_id:string;output_asset_id:string;issues:FeedbackIssue[];comment:string;status:'received'|'reviewing'|'resolved';created_at:string;updated_at:string;}
export const statusLabels: Record<JobStatus, string> = { queued: '排队中', running: '处理中', succeeded: '已完成', no_text: '未检测到文字', failed: '处理失败', cancelled: '已取消', outcome_unknown: '结果待核实' };
export const modeLabels: Record<Mode, string> = { classic: '常规翻译', redraw: 'AI 重绘翻译' };
export const languageLabel=(id:string)=>({ 'zh-Hans':'简体中文','zh-Hant':'繁體中文',en:'English',ja:'日本語',ko:'한국어' }[id]??id);
export const phaseLabels: Record<string, string> = { queued: '等待处理', preprocessing: '准备原图', detecting_ocr: '识别漫画文字', translating_text: '翻译对白', inpainting_rendering: '清理原文并排版', validating: '检查译图', calling_image_model: '图片模型翻译中', recovering_local: '恢复处理进度' };

export const fallbackLanguages = [{id:'zh-Hans',label:'简体中文'},{id:'en',label:'English'},{id:'ja',label:'日本語'}];
