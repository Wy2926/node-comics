import { ApiError, assertSession, authenticatedFetch, sessionIdentity } from './auth';
import type { RecordMeta, Snapshot } from './translation-store';
import type {TranslationModelChoice} from '../../../shared/translation-models';
export interface Guest {
  enabled: boolean;
  site_key: string;
  user_id: string | null;
  daily_limit: number;
  remaining: number;
  resets_at: string;
}
export interface Account {
  id: string;
  subject: string;
  name: string;
  sessionId: string;
}
export interface Capabilities {
  translation_models?:TranslationModelChoice[];
  result_protocol: string;
  representations?: string[];
  limits: { max_bytes: number; max_pixels: number; max_dimension: number };
  languages: { id: string; label: string }[];
  modes: { id: string; enabled: boolean; languages: string[] }[];
  entitlements?: {
    modes: Record<
      string,
      { allowed: boolean; unlimited: boolean; quota?: { available: number } }
    >;
  };
}
/** Resume exactly the stored intent; absent model fields remain absent for old centers. */
export function translationBody(meta:RecordMeta){
  return {...(meta.intent??{
    image:{sha256:meta.sha256,byte_size:meta.inputBytes,content_type:meta.mime,normalization_version:1},
    mode:meta.mode,target_language:meta.language,...(meta.resultFormat?{result_format:meta.resultFormat}:{}),
  }),...(meta.modelId?{model_id:meta.modelId}:{})};
}
export class TranslationError extends Error {
  constructor(
    public code: string,
    public status = 0,
    public retryAfter = 0,
  ) {
    super(code);
  }
}
export async function request(
  path: string,
  options: RequestInit = {},
  account?: Account,
  timeoutMs = 120000,
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('X-Translation-Protocol', 'overlay-v1');
  if (!account && path.startsWith('/v1/guest/')) headers.set('X-Guest-Request', '1');
  const timeout = AbortSignal.timeout(timeoutMs);
  const init: RequestInit = {
    ...options,
    headers,
    cache: 'no-store',
    credentials: account ? 'omit' : 'same-origin',
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
  };
  const identity = account ? { id: account.sessionId, subject: account.subject } : undefined;
  const response = await (account ? authenticatedFetch(path, init, identity).catch(error => {
    if (error instanceof ApiError && error.status === 401) throw new TranslationError('AUTH_REQUIRED', 401);
    throw error;
  }) : fetch(path, init));
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new TranslationError(
      body.error?.code || 'NETWORK_ERROR',
      response.status,
      Number(response.headers.get('Retry-After')) || 0,
    );
  }
  return response;
}
export async function json<T>(
  path: string,
  options: RequestInit = {},
  account?: Account,
): Promise<T> {
  const result = await (await request(path, options, account)).json();
  options.signal?.throwIfAborted();
  if (account) await assertSession(account.sessionId);
  return result as T;
}
export async function currentAccount(): Promise<Account | undefined> {
  const identity = await sessionIdentity();
  if (!identity) return undefined;
  const account = { id: '', name: '', subject: identity.subject, sessionId: identity.id };
  const { user } = await json<{ user: { id: string; name: string } }>('/v1/me', { signal: AbortSignal.timeout(15000) }, account);
  return { ...account, id: user.id, name: user.name };
}
export async function watch(
  path: string,
  id: string,
  account: Account | undefined,
  signal: AbortSignal,
  onSnapshot: (value: Snapshot) => Promise<void>,
): Promise<'complete' | 'reconnect'> {
  signal.throwIfAborted();
  const response = await request(
    path + '/events?ids=' + encodeURIComponent(id),
    { signal, headers: { Accept: 'text/event-stream' } },
    account,
    310000,
  );
  if (!response.body) throw new TranslationError('NETWORK_ERROR');
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let skipLF = false;
  let eventName = '';
  let data: string[] = [];
  let frameLength = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });

  const dispatch = async (): Promise<'complete' | 'reconnect' | undefined> => {
    const name = eventName;
    const body = data.join('\n');
    eventName = '';
    data = [];
    frameLength = 0;
    if (!body || (name !== 'snapshot' && name !== 'end')) return;
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      throw new TranslationError('NETWORK_ERROR');
    }
    if (name === 'end') {
      if (value?.reason === 'complete' || value?.reason === 'reconnect')
        return value.reason;
      throw new TranslationError('NETWORK_ERROR');
    }
    if (!Array.isArray(value?.items)) throw new TranslationError('NETWORK_ERROR');
    if (value.missing_ids?.includes(id)) throw new TranslationError('NOT_FOUND', 404);
    const snapshot = value.items.find((item: Snapshot) => item?.id === id);
    if (!snapshot || typeof snapshot.state !== 'string')
      throw new TranslationError('NETWORK_ERROR');
    await onSnapshot(snapshot);
    signal.throwIfAborted();
  };

  try {
    while (true) {
      signal.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            cancel();
            reject(new TranslationError('NETWORK_ERROR'));
          }, 45000);
        }),
      ]).finally(() => clearTimeout(timer));
      signal.throwIfAborted();
      // EOF without an explicit end frame is a disconnect, not completion.
      if (chunk.done) throw new TranslationError('NETWORK_ERROR');
      try {
        buffer += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new TranslationError('NETWORK_ERROR');
      }
      if (skipLF && buffer) {
        if (buffer[0] === '\n') buffer = buffer.slice(1);
        skipLF = false;
      }
      let split;
      while ((split = buffer.search(/[\r\n]/)) >= 0) {
        const line = buffer.slice(0, split);
        const cr = buffer[split] === '\r';
        const crlf = cr && buffer[split + 1] === '\n';
        skipLF = cr && split === buffer.length - 1;
        buffer = buffer.slice(split + (crlf ? 2 : 1));
        frameLength += line.length + 1;
        if (frameLength > 1024 * 1024) throw new TranslationError('NETWORK_ERROR');
        if (!line) {
          const reason = await dispatch();
          if (reason) return reason;
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'data') data.push(value);
      }
      if (frameLength + buffer.length > 1024 * 1024)
        throw new TranslationError('NETWORK_ERROR');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
