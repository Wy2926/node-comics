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
) {
  const response = await request(
    path + '/events?ids=' + encodeURIComponent(id),
    { signal },
    account,
    310000,
  );
  if (!response.body) throw Error('NETWORK_ERROR');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void reader.cancel();
            reject(Error('NETWORK_ERROR'));
          }, 45000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1024 * 1024) throw Error('NETWORK_ERROR');
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (event.startsWith('event: snapshot')) {
          const data = JSON.parse(
            event
              .split('\n')
              .find((line) => line.startsWith('data: '))!
              .slice(6),
          );
          for (const item of data.items) await onSnapshot(item);
        } else if (event.startsWith('event: end')) return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
