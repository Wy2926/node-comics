/** Product telemetry accepts categories and bounded counters, never content or identifiers. */
export const parameterValues = {
  surface:['reader','popup','options','inline'],
  screen:['library','remote-library','discover','search','sites','downloads','settings','account','reader'],
  source_type:['local','website','google_drive','opds','unknown'],
  format:['cbz','zip','cbr','rar','pdf','mobi','epub','website','image-sequence','unknown'],
  entry_point:['library','search','discover','popup','context_menu','inline','downloads','settings','other'],
  method:['manual','automatic'],
  outcome:['success','failed','duplicate','cancelled','empty','partial','blocked','no_text'],
  channel:['official','local'],
  mode:['original','classic','compare'],
  layout:['continuous','single'],
  search_mode:['direct','translated'],
  error_code:['network','permission','auth','quota','rate_limit','timeout','source_unavailable','unsupported','cancelled','unknown'],
  target_language:['zh-Hans','zh-Hant','en','ja','ko','fr','es','pt-BR','de','it','ru','pl','uk','tr','vi','id'],
  browser:['chrome','edge','firefox','other'],
  ui_language:['zh-CN','zh-TW','en','ja','ko','fr','es','pt-BR','de','it','ru','pl','uk','tr','vi','id'],
} as const;
type Categories = {[K in keyof typeof parameterValues]: typeof parameterValues[K][number]};
export type AnalyticsFields = Categories & {
  count: number;
  page_count: number;
  pages_viewed: number;
  result_count: number;
  duration_ms: number;
  active_ms: number;
  engagement_time_msec: number;
  extension_version: string;
};
const common = ['surface','browser','ui_language','extension_version'] as const;
const reading = ['source_type','format','layout','mode','target_language'] as const;
const translation = ['channel','mode','target_language','method'] as const;
export const eventParameters = {
  page_view:[...common,'screen'],
  extension_first_use:[...common],
  import_started:[...common,'source_type','format','count'],
  import_result:[...common,'source_type','format','outcome','count','duration_ms','error_code'],
  search_started:[...common,'search_mode'],
  search_result:[...common,'search_mode','outcome','result_count','duration_ms'],
  reader_open:[...common,...reading,'page_count'],
  reading_summary:[...common,...reading,'pages_viewed','active_ms','engagement_time_msec'],
  reading_engaged:[...common,...reading,'pages_viewed','active_ms'],
  reader_activated:[...common,...reading,'pages_viewed','active_ms'],
  translation_requested:[...common,...translation],
  translation_viewed:[...common,...translation,'duration_ms'],
  translation_view_changed:[...common,'mode','channel','target_language'],
  offline_download_result:[...common,'source_type','outcome','count','duration_ms'],
  quota_blocked:[...common,'mode','channel'],
  upgrade_click:[...common,'entry_point'],
} as const satisfies Record<string, readonly (keyof AnalyticsFields)[]>;
export type AnalyticsEventName = keyof typeof eventParameters;
export type AnalyticsParams<N extends AnalyticsEventName> = Partial<Pick<AnalyticsFields, typeof eventParameters[N][number]>>;
export interface AnalyticsEvent {
  event_id: string;
  name: AnalyticsEventName;
  params: Record<string, string | number>;
  timestamp_micros: number;
}
const counters = new Set(['count','page_count','pages_viewed','result_count']);
const durations = new Set(['duration_ms','active_ms','engagement_time_msec']);

export function sanitizeEvent(name: unknown, params: unknown): {name: AnalyticsEventName; params: Record<string, string | number>} | undefined {
  if (typeof name !== 'string' || !Object.hasOwn(eventParameters, name) || !params || typeof params !== 'object' || Array.isArray(params)) return;
  const cleaned: Record<string, string | number> = {};
  for (const key of eventParameters[name as AnalyticsEventName]) {
    const value = (params as Record<string, unknown>)[key];
    if (Object.hasOwn(parameterValues, key)) {
      if (typeof value === 'string' && (parameterValues[key as keyof Categories] as readonly string[]).includes(value)) {
        cleaned[key] = value;
      }
    } else if (key === 'extension_version') {
      if (typeof value === 'string' && value.length <= 32 && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) {
        cleaned[key] = value;
      }
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      if (counters.has(key) && value <= 10000 || durations.has(key) && value <= 86400000) {
        cleaned[key] = value;
      }
    }
  }
  return {name: name as AnalyticsEventName, params: cleaned};
}
