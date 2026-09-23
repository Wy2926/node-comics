/** Persistent locators contain JSON only; sessions own every disposable resource. */
export type ComicFormat = 'cbz' | 'cbr' | 'pdf' | 'mobi' | 'image';
export interface SourceSnapshot { identity: string; version: string; size: number; local: boolean }
export interface RandomAccessSource {
  readonly snapshot: SourceSnapshot;
  readAt(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  validate(signal?: AbortSignal): Promise<'unchanged' | 'changed' | 'unavailable'>;
  close(): Promise<void>;
}
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface IndexedPage { ordinal: number; name: string; locator: { [key: string]: JsonValue }; width?: number; height?: number }
export interface FormatCapabilities {
  access: 'random' | 'sequential' | 'full-buffer'; remote: boolean;
  solid?: boolean; encrypted: false; multiVolume: false; indexComplete: boolean;
}
export interface DocumentSession {
  readonly capabilities: FormatCapabilities;
  index(signal?: AbortSignal): Promise<IndexedPage[]>;
  materialize(page: IndexedPage, signal?: AbortSignal): Promise<Blob>;
  close(): Promise<void>;
}
export function throwIfAborted(signal?: AbortSignal) { signal?.throwIfAborted(); }
export function checkRange(source: RandomAccessSource, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > source.snapshot.size)
    throw new RangeError('源文件读取范围无效。');
}
