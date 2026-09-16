export type Mode = 'classic' | 'redraw';
export type TranslationProtocol = 'chat_completions' | 'responses';
export type TranslationProviderConfig = {
  base_url: string; model: string; protocol: TranslationProtocol; user_agent: string;
  timeout_seconds: number; max_attempts: number; max_output_tokens: number; group_bytes: number;
  input_rate: number; output_rate: number; pricing_version: string; requests_per_minute: number;
};
export type TranslationProvider = {
  id: string; name: string; channel: string; enabled: boolean; is_default: boolean;
  revision_id: string; credential_configured: boolean; config: TranslationProviderConfig;
  created_at: string; updated_at: string;
};
export type TranslationChannel = {id: string; label: string; protocols: string[]};
export type TranslationProviders = {items: TranslationProvider[]; channels: TranslationChannel[]};
export type TranslationProviderInput = {
  name: string; channel: 'openai'; enabled: boolean; config: TranslationProviderConfig; api_key?: string;
};
export type User = {id: string; name: string; role: string};
export type Page<T> = {items: T[]; total: number; next_offset: number | null; generated_at: string};
export type Overview = {
  generated_at: string; submitted_24h: number;
  users: {total: number; plus: number; submitted_24h: number};
  nodes: {total: number; online_enabled: number};
  leases: {running?: number; expired?: number};
  queues: {mode: Mode; status: string; priority: string; paused: boolean; count: number; oldest_seconds: number}[];
  stages: {name: string; status: string; count: number}[];
  completed_24h: {mode: Mode; status: string; count: number; avg_elapsed_seconds: number}[];
};
export type Task = {
  id: string; owner_id: string; owner_name: string; mode: Mode; target_language: string;
  status: string; phase: string; priority: string | null; queue_paused: boolean; cache_hit: boolean;
  page_index: number | null; created_at: string; completed_at: string | null; settlement: string;
  quota_pages: number; error_code: string | null; cancel_requested: boolean;
  elapsed_seconds: number; execution_seconds: number; non_execution_seconds: number;
  initial_wait_seconds: number; worker_seconds: number; started_at: string | null;
  nodes: {id: string; name: string}[]; running_nodes: string[]; expired_leases: number;
  completed_by: {node_id: string; name: string; executor_id: string | null} | null;
};
export type TaskDetail = Task & {
  error_message: string | null;
  generated_at: string; provider: {id: string; cost_state: string} | null;
  stages: {name: string; status: string; attempts: number; available_at: string; completed_at: string | null}[];
  executions: {id: string; stage: string; generation: number; node_id: string; node_name: string;
    executor_id: string | null; priority: string; started_at: string; completed_at: string | null;
    expires_at: string; seconds: number; outcome: string}[];
  text_cost_micros: number;
  text_calls: {id: string; model: string; provider_id: string; sequence: number; group: number;
    seconds: number | null; cost_state: string; accounted_micros: number; error_code: string | null}[];
};
export type Node = {
  config_version: number; applied_config_version: number; config_error: string | null; supported_languages: string[];
  id: string; name: string; resource_id: string; device: string; kind: string; capacity: number;
  capabilities: string[]; engine_version: string; enabled: boolean; online: boolean;
  heartbeat_at: string | null; heartbeat_age_seconds: number | null; running: number; expired_leases: number; occupied: number;
  completed_24h: {outcome: string; count: number; avg_seconds: number}[];
};
export type Nodes = {items: Node[]; generated_at: string; timeout_seconds: number};
export type AdminUser = User & {created_at: string; plan: string; plus_expires_at: string | null;
  last_submitted_at: string | null; jobs: Record<string, number>; active_jobs: number};
export type Bucket = {id: string; mode: Mode; source: string; granted: number; used: number; reserved: number; expires_at: string};
export type UserDetail = User & {
  operator_membership?: {active: boolean; expires_at: string | null};
  grants: (Bucket & {starts_at: string; note: string})[];
  created_at: string; queues: {mode: Mode; paused: boolean}[];
  entitlements: {plan: string; plus_expires_at: string | null; queue_capacity: number; realtime_slots: number;
    modes: Record<Mode, {unlimited: boolean; allowed: boolean; quota: null | {
      available: number; used: number; reserved: number; granted: number; resets_at: string | null; buckets: Bucket[]}}>
  };
};
