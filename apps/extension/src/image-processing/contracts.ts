import type {ImageTransferRequest} from '../image-transfer/types';

export interface ProcessingProfile {
  id: string;
  adapterId: string;
  name: string;
  revision: number;
  settings: Record<string, string>;
}
export interface ProcessingField {
  key: string;
  label: string;
  defaultValue: string;
  options?: readonly {value: string; label: string}[];
}
/** Adapters describe an image protocol, never translation, model execution or reader state. */
export interface ProcessingAdapter {
  id: string;
  label: string;
  guideUrl: string;
  fields: readonly ProcessingField[];
  normalize(settings: Record<string, string>): Record<string, string>;
  request(settings: Record<string, string>): ImageTransferRequest;
}
export type ProcessingState = {phase: 'queued' | 'running' | 'ready' | 'error'; message?: string};
/** No state until the cache lookup finishes; blob contains only the enhanced result. */
export interface ProcessingImage {identity: string; state?: ProcessingState; blob?: Blob; retry(): void;}
export interface ProcessingInput {
  /** Parent identity includes translation account, UUID and result revision when translated. */
  key: string;
  owner: string;
  /** Metadata/authorization only. Cache hits must not materialize the parent image. */
  validate(): Promise<void>;
  load(signal: AbortSignal): Promise<{blob: Blob; release(): void}>;
}
