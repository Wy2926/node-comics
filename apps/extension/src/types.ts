import {msg} from './i18n/runtime';
import type {UiLanguage} from './i18n/locales';
import type {EpubIndex, EpubLocation} from './comics/formats/contracts';
import type {TranslationResult} from '../../../backend/shared/translation-images/types';
import type {InputProfile} from '../../../backend/shared/translation-images/limits';
import type {TranslationModel,TranslationModelChoice} from '../../../backend/shared/translation-models';
export type {TranslationModel,TranslationModelChoice} from '../../../backend/shared/translation-models';
export type {TranslationArtifact,TranslationResult} from '../../../backend/shared/translation-images/types';
export type Mode = 'classic';
export interface MembershipGift {starts_at:string|null;ends_at:string|null;days:number;state:'pending'|'scheduled'|'active'|'expired'}
export type JobStatus = 'awaiting_upload' | 'validating_upload' | 'queued' | 'running' | 'succeeded' | 'no_text' | 'failed' | 'cancelled' | 'outcome_unknown' | 'unknown_released';
/** Local source binding; never substitutes the server's actual input digest. */
export interface Job {source_image_sha256?:string;input_profile?:InputProfile;requested_model_id?:string|null;model?:TranslationModel|null;}
export interface Job { result?: {key:string;recoverable:boolean}; delivery?:TranslationResult; id: string; mode: Mode; target_language: string; status: JobStatus; phase: string; error?: { code: string; message: string }; quota_pages: number; quota_kind?:QuotaKind; quota_period_id?:string|null; created_at: string; completed_at?: string; version: number; cache_hit: boolean; reused?:boolean; quality_flags?: string[]; result_available?: boolean; result_expired?: boolean; settlement?: 'reserved'|'settled'|'released'|'free'|'included'; cancel_requested?:boolean; image_sha256?:string;  updated_at?:string; }
export interface TranslationImage {sha256:string;byte_size:number;content_type:string;normalization_version?:1;}
export type TranslationInput = ({image:TranslationImage;mode:Mode;target_language:string;result_format?:'overlay-tiles-v1'}|{retry_of:string}|{regenerate_of:string})&{model_id?:string|null};
export interface TranslationSnapshot {requested_model_id?:string|null;model?:TranslationModel|null;}
export interface Capabilities {translation_models?:TranslationModelChoice[];}
export interface TranslationSnapshot {id:string;state:'needs_input'|'queued'|'running'|'succeeded'|'failed'|'needs_attention';mode:Mode;target_language:string;image_sha256?:string;created_at?:string;updated_at?:string;result?:TranslationResult|null;error?:{code:string;message:string}|null;}
export interface TranslationBatch {items:TranslationSnapshot[];missing_ids:string[];}
export interface ImageRateLimit {window_seconds:number;limit:number;remaining?:number;retry_after_seconds?:number;}
/** Reader-only projection; persisted page descriptors never contain jobs or image bytes. */
export interface Page { translationScope?: string; entryId?: string; contentId?: string; renderProfileId?: string; id: string; name: string; width: number; height: number; imageSha256?: string; imageByteSize?:number;imageMime?:string; blobKey?: string; sourceUrl?: string; fetchError?: string; translationError?: string; ownerId?: string; apiOrigin?:string; jobs: Job[]; outputBlobs: Record<string, string>; }
/** Bounded reader session view model, not a persisted catalog record. */
export interface ReadingEntry {
  comicId?:string; contentId?:string; id:string; title:string; source:string; sourceKey:string;
  sourceUrl?:string; sourceEntryId?:string; generation:number; createdAt:number; updatedAt:number;
  lastReadAt?:number; coverPageId?:string; pages:Page[]; pageId:string; relativeOffset:number;
  demo?:boolean; discoveryComplete:boolean; knownTotal?:number;
  catalogUpdateRevision?:number;
  document?:EpubIndex; documentLocation?:EpubLocation;
}
export interface User { id: string; name: string; role: string; }
export type QuotaKind='classic_monthly'|'classic_daily'|'classic_unlimited'|'classic_grant'|'classic_purchase'|'unavailable';
export interface QuotaBucket {id:string;kind:QuotaKind;mode:Mode;source:'daily'|'membership'|'grant'|'subscription'|'purchase';granted:number;used:number;reserved:number;available:number;starts_at:string;expires_at:string|null;grants_access:boolean;note:string;}
export interface QuotaSummary {id:string;kind:QuotaKind;granted:number;used:number;reserved:number;available:number;starts_at:string;resets_at:string|null;next_expiry_at:string|null;buckets:QuotaBucket[];}
export interface ModeEntitlement {allowed:boolean;unlimited:boolean;quota_kind:QuotaKind;consent_version:string;quota:QuotaSummary|null;}
export interface PurchaseQuota {granted:number;used:number;reserved:number;available:number;next_expiry_at:string|null;}
export interface PeriodicQuota extends PurchaseQuota {resets_at?:string|null;}
export interface QuotaPurchase extends QuotaBucket {order_id:string;service_plan:string;product_name:string;hourly_image_limit:number|null;revoked_at:string|null;state:'scheduled'|'active'|'exhausted'|'expired'|'revoked';}
export interface QuotaPurchases {items:QuotaPurchase[];next_cursor:string|null;}
export interface Entitlements {plan:string;plan_name?:string;free_quota?:PeriodicQuota;subscription_quota?:PeriodicQuota&{unlimited:boolean};service_plan?:string;purchase_quota?:PurchaseQuota|null;plus_started_at:string|null;plus_expires_at:string|null;gift?:MembershipGift|null;timezone:string;image_rate_limit:ImageRateLimit;hourly_image_rate_limit?:ImageRateLimit|null;modes:Record<Mode,ModeEntitlement>;generated_at:string;pending_previous_period_pages:number;}
export interface Capabilities { result_protocol?:'overlay-v1'; representations?:string[]; modes: { id: Mode; label: string; enabled: boolean; languages?:string[] }[]; languages: { id: string; label: string }[]; limits: { max_bytes: number; max_pixels: number; max_dimension: number; max_translation_ids: number }; entitlements:Entitlements|null; }
export interface Usage { entitlements:Entitlements; items: { id: string; job_id: string|null;period_id:string|null;quota_kind:QuotaKind|null;kind: string; pages: number; created_at: string; note?:string }[]; total: number; next_offset?:number|null; }
export interface Settings { uiLanguage: UiLanguage; autoTranslateTabs:boolean; discoveryTextTranslation:boolean; language: string; direction: 'ltr' | 'rtl'; layout: 'continuous' | 'single'; fit: 'width' | 'window'; cacheLimitMb: number; appearance:'system'|'light'|'dark'; accentTheme:'sky'|'rose'|'mint'|'iris'|'amber'|'slate'; readerBackground:'gray'|'paper'|'night'; textScale:number; }
export const defaults: Settings = { uiLanguage: 'auto', autoTranslateTabs:false, discoveryTextTranslation:true, language: 'zh-Hans', direction: 'ltr', layout: 'continuous', fit: 'window', cacheLimitMb: 1024, appearance:'system',accentTheme:'sky',readerBackground:'gray',textScale:1 };

export interface UsageSummary {entitlements:Entitlements;timezone:string;start_date:string;end_date:string;generated_at:string;delivered:number;free_delivered:number;included_delivered:number;by_mode:Record<string,number>;quota_used:Record<string,number>;days:{date:string;delivered:number;classic:number}[];}
export interface Paginated<T>{items:T[];total:number;next_offset:number|null;}
export type FeedbackIssue='missing_text'|'meaning'|'typesetting'|'art_changed'|'other';
export interface FeedbackRecord {id:string;translation_id:string;issues:FeedbackIssue[];comment:string;status:'received'|'reviewing'|'resolved';created_at:string;updated_at:string;}
export const statusLabels: Record<JobStatus, string> = { get awaiting_upload(){return msg("等待原图上传");}, get validating_upload(){return msg("校验原图");}, get queued(){return msg("服务器排队");}, get running(){return msg("处理中");}, get succeeded(){return msg("已完成");}, get no_text(){return msg("未检测到文字");}, get failed(){return msg("处理失败");}, get cancelled(){return msg("已取消");}, get outcome_unknown(){return msg("结果待核实");},get unknown_released(){return msg("核实期限已结束");} };
export const modeLabels: Record<Mode, string> = { get classic(){return msg("常规翻译");} };
export const languageLabels:Record<string,string>={ 'zh-Hans':'简体中文','zh-Hant':'繁體中文',en:'English',ja:'日本語',ko:'한국어',fr:'Français',es:'Español','pt-BR':'Português (Brasil)',de:'Deutsch',it:'Italiano',ru:'Русский',pl:'Polski',uk:'Українська',tr:'Türkçe',vi:'Tiếng Việt',id:'Bahasa Indonesia' };
export const languageLabel=(id:string)=>languageLabels[id]??id;
export const phaseLabels: Record<string, string> = { get queued(){return msg("等待处理");}, get preprocessing(){return msg("准备原图");}, get detecting_ocr(){return msg("识别漫画文字");}, get translating_text(){return msg("翻译对白");}, get inpainting_rendering(){return msg("清理原文并排版");}, get validating_upload(){return msg("检查译图");}, get recovering_local(){return msg("恢复处理进度");} };

export const fallbackLanguages = Object.entries(languageLabels).map(([id,label])=>({id,label}));
export const supportsLanguage=(caps:Capabilities|undefined,mode:Mode,language:string)=>mode==='classic'&&(caps?.modes.find(m=>m.id===mode)?.languages?.includes(language)??language in languageLabels);
