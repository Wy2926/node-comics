import { session } from './auth';
import type { Snapshot } from './translation-store';
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
}
export interface Capabilities {
  result_protocol: string;
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
  if (account) {
    const auth = await session();
    if (!auth || auth.profile.sub !== account.subject)
      throw new TranslationError('AUTH_REQUIRED', 401);
    headers.set('Authorization', 'Bearer ' + auth.access_token);
  } else if (path.startsWith('/v1/guest/')) headers.set('X-Guest-Request', '1');
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(path, {
    ...options,
    headers,
    cache: 'no-store',
    credentials: account ? 'omit' : 'same-origin',
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
  });
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
  return (await request(path, options, account)).json();
}
export async function currentAccount(): Promise<Account | undefined> {
  if (
    !Object.keys(sessionStorage).some((key) => key.startsWith('nc-site-user:'))
  )
    return undefined;
  const auth = await session();
  if (!auth) throw new TranslationError('AUTH_REQUIRED', 401);
  const response = await fetch('/v1/me', {
    headers: { Authorization: 'Bearer ' + auth.access_token },
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new TranslationError('AUTH_REQUIRED', 401);
  const { user } = await response.json();
  return { id: user.id, name: user.name, subject: auth.profile.sub };
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
