import {msg} from './i18n/runtime';
import type {UiLanguage} from './i18n/locales';
export type Mode = 'redraw' | 'classic';
export type JobStatus = 'awaiting_upload' | 'validating_upload' | 'queued' | 'running' | 'succeeded' | 'no_text' | 'failed' | 'cancelled' | 'outcome_unknown' | 'unknown_released';
export interface Job { id: string; input_asset_id: string | null; requested_asset_id?: string | null; output_asset_id: string | null; mode: Mode; target_language: string; status: JobStatus; phase: string; error?: { code: string; message: string }; quota_pages: number; quota_kind?:QuotaKind; quota_period_id?:string|null; created_at: string; completed_at?: string; version: number; cache_hit: boolean; reused?:boolean; quality_flags?: string[]; result_available?: boolean; result_expired?: boolean; settlement?: 'reserved'|'settled'|'released'|'free'|'included'; cancel_requested?:boolean; file_hash?:string|null; page_index?:number|null; image_sha256?:string; priority?:'realtime'|'preload'; priority_rank?:number; updated_at?:string;change_sequence?:number; }
export interface FilePageSource { file_hash: string; page_index: number; image_sha256?: string; }
export interface ImageAsset { id: string; width: number; height: number; expires_at: string|null; sha256?:string;byte_size?:number;mime?:string; }
export interface FilePageMatch extends FilePageSource { asset: ImageAsset | null; jobs: Job[]; display_jobs?: Job[]; }
export interface UploadPlan {id:string;url:string;method:'PUT';headers:Record<string,string>;expires_at:string;authorization_required?:boolean;}
export interface TranslationImage {client_item_id:string;file_hash?:string;page_index?:number;image_sha256:string;byte_size:number;content_type:string;name:string;asset_id?:string;}
export interface PlanItem {page_key:string;operation_key:string;role:'current'|'prefetch';mode:Mode;target_language:string;max_quota_pages:number;expected_kind?:QuotaKind;image:TranslationImage;job_id?:string;action?:'ensure'|'retry'|'regenerate';source_job_id?:string;acknowledge_unknown_cost?:boolean;}
export interface TranslationPlan {trigger:'reading'|'manual';session_id?:string;sequence?:number;priority_epochs?:Partial<Record<Mode,number>>;allow_new?:boolean;items:PlanItem[];}
export interface TranslationOperation {page_key?:string;operation_key:string;disposition:'ready'|'pending'|'accepted'|'deferred'|'blocked'|'not_found';job?:Job;display_jobs?:Job[];upload?:UploadPlan|null;reused?:boolean;code?:string;message?:string;retry_after_seconds?:number;created_at?:string;}
export interface ImageRateLimit {window_seconds:number;limit:number;remaining?:number;retry_after_seconds?:number;}
export interface ReadingPriority {owned:boolean;epoch:number;expires_at?:string;}
export interface PlanReceipt {session_id?:string;applied_sequence?:number;priority?:Partial<Record<Mode,ReadingPriority>>;policy_revision:string;server_time?:string;image_rate_limit?:ImageRateLimit;entitlements?:Entitlements;items:TranslationOperation[];}
export interface TranslationChanges {items:Job[];deleted_job_ids:string[];cursor:string;has_more:boolean;policy_revision?:string;entitlements?:Entitlements;image_rate_limit?:ImageRateLimit;}
/** Reader-only projection; persisted page descriptors never contain jobs or image bytes. */
export interface Page { entryId?: string; contentId?: string; renderProfileId?: string; id: string; name: string; width: number; height: number; fileHash?: string; pageIndex?: number; imageSha256?: string; imageByteSize?:number;imageMime?:string; blobKey?: string; sourceUrl?: string; fetchError?: string; translationError?: string; assetId?: string; assetExpiresAt?: string|null; ownerId?: string; apiOrigin?:string; jobs: Job[]; outputBlobs: Record<string, string>; }
/** Bounded reader session view model, not a persisted catalog record. */
export interface ReadingEntry {
  comicId?:string; contentId?:string; id:string; title:string; source:string; sourceKey:string;
  sourceUrl?:string; sourceEntryId?:string; generation:number; createdAt:number; updatedAt:number;
  lastReadAt?:number; coverPageId?:string; pages:Page[]; pageId:string; relativeOffset:number;
  demo?:boolean; discoveryComplete:boolean; knownTotal?:number;
  catalogUpdateRevision?:number;
}
export interface User { id: string; name: string; role: string; }
export type QuotaKind='classic_daily'|'classic_unlimited'|'redraw_monthly'|'classic_grant'|'redraw_grant'|'unavailable';
export interface QuotaBucket {id:string;kind:QuotaKind;mode:Mode;source:'daily'|'membership'|'grant'|'subscription';granted:number;used:number;reserved:number;available:number;starts_at:string;expires_at:string;grants_access:boolean;note:string;}
export interface QuotaSummary {id:string;kind:QuotaKind;granted:number;used:number;reserved:number;available:number;starts_at:string;resets_at:string|null;next_expiry_at:string;buckets:QuotaBucket[];}
export interface ModeEntitlement {allowed:boolean;unlimited:boolean;quota_kind:QuotaKind;consent_version:string;quota:QuotaSummary|null;}
export interface Entitlements {plan:'free'|'plus';plus_started_at:string|null;plus_expires_at:string|null;timezone:string;image_rate_limit:ImageRateLimit;scheduler_weight:number;modes:Record<Mode,ModeEntitlement>;generated_at:string;pending_previous_period_pages:number;}
export interface Capabilities { modes: { id: Mode; label: string; enabled: boolean; languages?:string[] }[]; languages: { id: string; label: string }[]; limits: { max_bytes: number; max_pixels: number; max_dimension: number; max_plan_items: number }; entitlements:Entitlements|null; retention_days: number; }
export interface Usage { entitlements:Entitlements; items: { id: string; job_id: string|null;period_id:string|null;quota_kind:QuotaKind|null;kind: string; pages: number; created_at: string; note?:string }[]; total: number; next_offset?:number|null; }
export interface Settings { uiLanguage: UiLanguage; autoTranslateTabs:boolean; language: string; translationMode: Mode; direction: 'ltr' | 'rtl'; layout: 'continuous' | 'single'; fit: 'width' | 'window'; cacheLimitMb: number; appearance:'system'|'light'|'dark'; accentTheme:'sky'|'rose'|'mint'|'iris'; readerBackground:'gray'|'paper'|'night'; textScale:number; }
export const defaults: Settings = { uiLanguage: 'auto', autoTranslateTabs:false, language: 'zh-Hans', translationMode: 'classic', direction: 'ltr', layout: 'continuous', fit: 'window', cacheLimitMb: 1024, appearance:'system',accentTheme:'sky',readerBackground:'gray',textScale:1 };

export interface UsageSummary {entitlements:Entitlements;timezone:string;start_date:string;end_date:string;generated_at:string;delivered:number;free_delivered:number;included_delivered:number;by_mode:Record<string,number>;quota_used:Record<string,number>;days:{date:string;delivered:number;classic:number;redraw:number}[];}
export interface Paginated<T>{items:T[];total:number;next_offset:number|null;}
export type FeedbackIssue='missing_text'|'meaning'|'typesetting'|'art_changed'|'other';
export interface FeedbackRecord {id:string;job_id:string;output_asset_id:string;issues:FeedbackIssue[];comment:string;status:'received'|'reviewing'|'resolved';created_at:string;updated_at:string;}
export const statusLabels: Record<JobStatus, string> = { get awaiting_upload(){return msg("等待原图上传");}, get validating_upload(){return msg("校验原图");}, get queued(){return msg("服务器排队");}, get running(){return msg("处理中");}, get succeeded(){return msg("已完成");}, get no_text(){return msg("未检测到文字");}, get failed(){return msg("处理失败");}, get cancelled(){return msg("已取消");}, get outcome_unknown(){return msg("结果待核实");},get unknown_released(){return msg("核实期限已结束");} };
export const modeLabels: Record<Mode, string> = { get classic(){return msg("常规翻译");}, get redraw(){return msg("AI 重绘翻译");} };
export const languageLabels:Record<string,string>={ 'zh-Hans':'简体中文','zh-Hant':'繁體中文',en:'English',ja:'日本語',ko:'한국어',fr:'Français',es:'Español','pt-BR':'Português (Brasil)',de:'Deutsch',it:'Italiano',ru:'Русский',pl:'Polski',uk:'Українська',tr:'Türkçe',vi:'Tiếng Việt',id:'Bahasa Indonesia' };
export const languageLabel=(id:string)=>languageLabels[id]??id;
export const phaseLabels: Record<string, string> = { get queued(){return msg("等待处理");}, get preprocessing(){return msg("准备原图");}, get detecting_ocr(){return msg("识别漫画文字");}, get translating_text(){return msg("翻译对白");}, get inpainting_rendering(){return msg("清理原文并排版");}, get validating_upload(){return msg("检查译图");}, get calling_image_model(){return msg("图片模型翻译中");}, get recovering_local(){return msg("恢复处理进度");} };

export const fallbackLanguages = Object.entries(languageLabels).map(([id,label])=>({id,label}));
export const supportsLanguage=(caps:Capabilities|undefined,mode:Mode,language:string)=>caps?.modes.find(m=>m.id===mode)?.languages?.includes(language)??(mode==='classic'?language in languageLabels:['zh-Hans','zh-Hant','en','ja','ko'].includes(language));
