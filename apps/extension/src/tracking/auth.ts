import {aniListProvider, TrackingError} from './anilist';
import {
  beginPrivateTrackingAuthorization, clearPrivateTrackingCredential, commitPrivateTrackingCredential,
  endPrivateTrackingAuthorization, readPrivateTrackingCredential, type TrackingCredential,
} from './private-store';

export type {TrackingCredential} from './private-store';
const lifetime = 10 * 60_000;

export function getAniListAuthConfiguration(): {clientId: string; redirectUrl: string; configured: boolean} {
  const clientId = String(import.meta.env.VITE_ANILIST_CLIENT_ID ?? '').trim();
  const supported = typeof chrome !== 'undefined' && typeof chrome.identity?.launchWebAuthFlow === 'function' && typeof chrome.identity?.getRedirectURL === 'function';
  const redirectUrl = supported ? chrome.identity.getRedirectURL('anilist') : '';
  return {clientId, redirectUrl, configured: /^[1-9]\d*$/.test(clientId) && Boolean(redirectUrl)};
}

function tokenExpiry(parameters: URLSearchParams, token: string, now: number): number {
  const seconds = parameters.get('expires_in');
  let expiresAt = seconds && /^\d+$/.test(seconds) ? now + Number(seconds) * 1000 : 0;
  // AniList documents JWT access tokens. exp is only an expiry hint: Viewer,
  // not this unverified payload, proves token validity and account identity.
  try {
    const encoded = token.split('.')[1];
    const raw = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) as {exp?: unknown};
    if (typeof raw.exp === 'number' && Number.isSafeInteger(raw.exp)) expiresAt = expiresAt ? Math.min(expiresAt, raw.exp * 1000) : raw.exp * 1000;
  } catch { /* Some valid access tokens may be opaque. */ }
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 366 * 24 * 60 * 60_000) throw new TrackingError('auth');
  return expiresAt;
}

export function validateAniListCallback(callback: string, redirectUrl: string, state: string, startedAt: number, now = Date.now()): {token: string; expiresAt: number} {
  let returned: URL, expected: URL;
  try {returned = new URL(callback); expected = new URL(redirectUrl);} catch {throw new TrackingError('auth');}
  if (returned.origin !== expected.origin || returned.pathname !== expected.pathname || returned.username || returned.password || now < startedAt || now - startedAt > lifetime) throw new TrackingError('auth');
  const parameters = new URLSearchParams(returned.hash.slice(1));
  const states = [...parameters.getAll('state'), ...returned.searchParams.getAll('state')];
  if (states.length !== 1 || states[0] !== state || !state) throw new TrackingError('auth');
  const errors = [...parameters.getAll('error'), ...returned.searchParams.getAll('error')];
  if (errors.length) throw new TrackingError(errors.length === 1 && errors[0] === 'access_denied' ? 'cancelled' : 'authorization');
  const tokens = parameters.getAll('access_token'), token = tokens[0];
  if (tokens.length !== 1 || !token || token.length > 16_384 || /\s/.test(token) || parameters.get('token_type')?.toLowerCase() !== 'bearer' || returned.searchParams.has('access_token')) throw new TrackingError('auth');
  return {token, expiresAt: tokenExpiry(parameters, token, now)};
}

export const getTrackingCredential = readPrivateTrackingCredential;

async function duringAuthorization<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw new TrackingError('cancelled');
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {cancel = () => reject(new TrackingError('cancelled'));});
  signal.addEventListener('abort', cancel, {once: true});
  try {return await Promise.race([operation, cancelled]);}
  finally {signal.removeEventListener('abort', cancel);}
}

export async function connectAniList(options: {signal?: AbortSignal} = {}): Promise<TrackingCredential> {
  const {signal} = options;
  const current = () => {if (signal?.aborted) throw new TrackingError('cancelled');};
  current();
  const config = getAniListAuthConfiguration();
  if (!config.configured) throw new TrackingError('configuration');
  const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
  const startedAt = Date.now();
  const authorization = new URL('https://anilist.co/api/v2/oauth/authorize');
  authorization.search = new URLSearchParams({client_id: config.clientId, response_type: 'token', redirect_uri: config.redirectUrl, state}).toString();
  await beginPrivateTrackingAuthorization(state);
  try {
    current();
    let callback: string | undefined;
    try {callback = await duringAuthorization(chrome.identity.launchWebAuthFlow({url: authorization.href, interactive: true}), signal);}
    catch (error) {
      current();
      // Only known browser cancellation messages mean the user cancelled. Never
      // forward raw errors: they may contain the authorization URL or credentials.
      const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
      const cancelled = message === 'The user did not approve access.' || message === 'User cancelled or denied access.';
      throw new TrackingError(cancelled ? 'cancelled' : 'authorization');
    }
    current();
    if (!callback) throw new TrackingError('cancelled');
    const credential = validateAniListCallback(callback, config.redirectUrl, state, startedAt);
    // The browser-owned flow closes its callback window; never navigate our UI
    // to the returned fragment, persist it, send it over IPC or log its URL.
    callback = undefined;
    const viewer = await duringAuthorization(aniListProvider.viewer(credential.token), signal);
    current();
    const saved = await commitPrivateTrackingCredential(state, {
      accountId: viewer.id, name: viewer.name, ...credential, epoch: crypto.randomUUID(),
    });
    if (!saved) throw new TrackingError('cancelled');
    return saved;
  } finally { await endPrivateTrackingAuthorization(state); }
}

export const disconnectAniList = clearPrivateTrackingCredential;
