import { ApiError, assertSession, authenticatedFetch, type AuthIdentity } from './auth';

export interface DocumentCapabilities {
  enabled: boolean;
  limits: { max_bytes: number; max_pages: number; part_bytes: number; waiting_hours: number };
  languages: { id: string; label: string }[];
  models: { id: string; name: string }[];
}
export interface DocumentTask {
  id: string;
  status: 'uploading' | 'preflight' | 'awaiting_quota' | 'queued' | 'running' | 'outcome_unknown' | 'succeeded' | 'failed' | 'cancelled';
  phase: string;
  version: number;
  filename: string;
  source_type: 'pdf' | 'zip';
  byte_size: number;
  page_count: number | null;
  target_language: string;
  model: { id: string; name: string };
  progress: Record<string, number>;
  quota: { reserved: number; used: number; released: number; needed: number | null; available: number | null; difference: number | null; checked_at: string | null };
  cancellable: boolean;
  resumable: boolean;
  downloadable: boolean;
  error_code: string | null;
  created_at: string;
  expires_at: string;
  upload: { part_bytes: number; part_count: number } | null;
}
export interface DocumentHistory { items: DocumentTask[]; next_cursor: string | null }
export interface DocumentInput {
  filename: string; source_type: 'pdf' | 'zip'; byte_size: number; sha256: string; target_language: string; model_id: string;
}
interface SignedPart { part_number: number; url: string; headers: Record<string, string>; expires_in: number }
export class DocumentError extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}

export async function documentRequest<T>(path: string, identity: AuthIdentity, options: RequestInit = {}): Promise<T> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  try {
    const response = await authenticatedFetch('/v1/documents' + path, {
      ...options, signal, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    }, identity);
    const result = await response.json().catch(() => ({}));
    signal.throwIfAborted();
    await assertSession(identity.id);
    if (!response.ok) throw new DocumentError(result.error?.code || 'NETWORK_ERROR', response.status);
    return result as T;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw new DocumentError('AUTH_REQUIRED', 401);
    throw error;
  }
}

export function documentSourceType(filename: string): 'pdf' | 'zip' {
  if (/\.pdf$/i.test(filename)) return 'pdf';
  if (/\.(zip|cbz)$/i.test(filename)) return 'zip';
  throw new DocumentError('DOCUMENT_UNSUPPORTED_FORMAT');
}

export function hashDocument(file: File, signal: AbortSignal, progress: (bytes: number) => void): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-hash.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { signal.removeEventListener('abort', cancel); worker.terminate(); };
    const cancel = () => { finish(); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.error) { finish(); reject(new DocumentError(data.error)); }
      else if (data.sha256) { finish(); resolve(data.sha256); }
      else if (typeof data.bytes === 'number') progress(data.bytes);
    };
    worker.onerror = () => { finish(); reject(new DocumentError('DOCUMENT_HASH_FAILED')); };
    // Structured clone shares the Blob backing data, not a 200 MB ArrayBuffer.
    worker.postMessage(file);
  });
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

export function signedObjectUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new DocumentError('DOCUMENT_STORAGE_UNAVAILABLE');
  return url.href;
}

/** At most two in-flight Blob slices. A failed part alone reacquires its signature. */
export async function transferDocumentParts(file: Blob, partBytes: number, completed: Set<number>, signal: AbortSignal,
  sign: (part: number, signal: AbortSignal) => Promise<SignedPart>,
  put: (part: SignedPart, blob: Blob, signal: AbortSignal) => Promise<void>,
  progress: (bytes: number) => void = () => {}, retryDelay = 500) {
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || file.size > 200_000_000) throw new DocumentError('DOCUMENT_PART_INVALID');
  const count = Math.ceil(file.size / partBytes);
  if (count < 1 || count > 40 || [...completed].some(part => !Number.isInteger(part) || part < 1 || part > count)) throw new DocumentError('DOCUMENT_PART_INVALID');
  const parts = Array.from({ length: count }, (_, index) => index + 1).filter(part => !completed.has(part));
  const controller = new AbortController(), bound = AbortSignal.any([signal, controller.signal]);
  const bytes = () => [...completed].reduce((sum, part) => sum + Math.min(partBytes, file.size - (part - 1) * partBytes), 0);
  progress(bytes());
  let next = 0;
  const run = async () => {
    while (next < parts.length) {
      bound.throwIfAborted();
      const part = parts[next++];
      const blob = file.slice((part - 1) * partBytes, Math.min(file.size, part * partBytes));
      for (let attempt = 0; ; attempt++) {
        try {
          const signed = await sign(part, bound);
          if (signed.part_number !== part) throw new DocumentError('DOCUMENT_PART_INVALID', 400);
          await put(signed, blob, bound);
          bound.throwIfAborted();
          completed.add(part); progress(bytes()); break;
        } catch (error) {
          bound.throwIfAborted();
          const status = error instanceof DocumentError ? error.status : 0;
          if (attempt >= 2 || (status >= 400 && status < 500 && ![403, 408, 429].includes(status))) throw error;
          await pause(retryDelay * 2 ** attempt, bound);
        }
      }
    }
  };
  const workers = [run(), run()];
  try { await Promise.all(workers); }
  catch (error) { controller.abort(); await Promise.allSettled(workers); throw error; }
}

export function uploadDocumentParts(id: string, file: File, partBytes: number, completed: Set<number>, identity: AuthIdentity,
  signal: AbortSignal, progress: (bytes: number) => void) {
  return transferDocumentParts(file, partBytes, completed, signal,
    async (number, bound) => {
      const result = await documentRequest<{ parts: SignedPart[] }>('/' + id + '/upload-parts', identity,
        { method: 'POST', body: JSON.stringify({ part_numbers: [number] }), signal: bound });
      return result.parts[0];
    }, async (part, blob, bound) => {
      const headers = new Headers(part.headers);
      if (headers.has('Authorization') || headers.has('Cookie')) throw new DocumentError('DOCUMENT_STORAGE_UNAVAILABLE', 400);
      const response = await fetch(signedObjectUrl(part.url), { method: 'PUT', body: blob, headers,
        credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([bound, AbortSignal.timeout(180000)]) });
      if (!response.ok) throw new DocumentError('DOCUMENT_UPLOAD_FAILED', response.status);
    }, progress);
}
