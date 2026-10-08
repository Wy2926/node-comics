/* SPDX-License-Identifier: GPL-3.0-only
 * AniList protocol adapted from MALSync 0.12.5 (lolamtisch and contributors).
 * Upstream files, immutable revision and original hashes: ../../THIRD_PARTY.md.
 * Node Comics changes: manga-only schemas, minimal mutations, strict validation,
 * credential-free search, bounded requests and shared response-header cooldown.
 */
import {aniListRateLimit, createAniListRateLimit, type AniListRateLimit} from './rate-limit';

export type TrackingStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'REPEATING';
export interface TrackingRemoteEntry {id: number; mediaId: number; userId: number; progress: number; status: TrackingStatus}
export interface TrackingMedia {id: number; title: string; chapters: number | null; entry: TrackingRemoteEntry | null}
export type TrackingErrorCode = 'auth' | 'authorization' | 'rate-limit' | 'unavailable' | 'invalid' | 'identity' | 'configuration' | 'cancelled';
export class TrackingError extends Error {
  constructor(readonly code: TrackingErrorCode, readonly retryAt?: number) {
    // Never forward provider messages: they may echo secrets or private records.
    super(`AniList ${code}`);
    this.name = 'TrackingError';
  }
}

const endpoint = 'https://graphql.anilist.co';
const entryFields = 'id mediaId userId progress status';
const mediaFields = 'id type format title { userPreferred native english romaji } chapters';
const statuses = new Set<unknown>(['CURRENT', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING']);
type Value = Record<string, unknown>;
const object = (value: unknown): Value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : {};
const int = (value: unknown, minimum = 1): value is number => Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= 2_147_483_647;
function requireId(value: number) { if (!int(value)) throw new TrackingError('invalid'); }
function entry(value: unknown, mediaId: number): TrackingRemoteEntry {
  const raw = object(value);
  if (!int(raw.id) || !int(raw.mediaId) || !int(raw.userId) || !int(raw.progress, 0) || !statuses.has(raw.status)) throw new TrackingError('invalid');
  if (raw.mediaId !== mediaId) throw new TrackingError('identity');
  return {id: raw.id, mediaId: raw.mediaId, userId: raw.userId, progress: raw.progress, status: raw.status as TrackingStatus};
}
function media(value: unknown, authenticated: boolean): TrackingMedia {
  const raw = object(value), titles = object(raw.title);
  const title = [titles.userPreferred, titles.native, titles.english, titles.romaji].find(value => typeof value === 'string' && value.trim());
  if (!int(raw.id) || raw.type !== 'MANGA' || !['MANGA', 'ONE_SHOT'].includes(String(raw.format)) || typeof title !== 'string' || (raw.chapters !== null && !int(raw.chapters))) throw new TrackingError('invalid');
  if (authenticated && raw.mediaListEntry === undefined) throw new TrackingError('invalid');
  return {id: raw.id, title: title.trim().slice(0, 300), chapters: raw.chapters as number | null,
    entry: authenticated && raw.mediaListEntry !== null ? entry(raw.mediaListEntry, raw.id) : null};
}

export class AniListProvider {
  private readonly fetcher: typeof fetch;
  private readonly rateLimit: AniListRateLimit;
  constructor(options: {fetcher?: typeof fetch; now?: () => number; rateLimit?: AniListRateLimit} = {}) {
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
    this.rateLimit = options.rateLimit ?? (options.now ? createAniListRateLimit(options.now) : aniListRateLimit);
  }
  private async request(query: string, variables: Value, token?: string): Promise<Value> {
    const retryAt = await this.rateLimit.availableAt();
    if (retryAt) throw new TrackingError('rate-limit', retryAt);
    if (token !== undefined && (!token || token.length > 16_384 || /\s/.test(token))) throw new TrackingError('auth');
    try {
      const response = await this.fetcher(endpoint, {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
        headers: {'Content-Type': 'application/json', Accept: 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
        body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(15_000),
      });
      const cooldown = await this.rateLimit.observe(response);
      if (response.status === 429) throw new TrackingError('rate-limit', cooldown);
      if (response.status === 401 || response.status === 403) throw new TrackingError('auth');
      if (!response.ok) throw new TrackingError(response.status >= 500 ? 'unavailable' : 'invalid');
      const payload = object(await response.json());
      if (Array.isArray(payload.errors) && payload.errors.length) {
        const failures = payload.errors.map(object);
        if (failures.some(value => value.status === 429)) {
          const retry = await this.rateLimit.observe(new Response(null, {status: 429, headers: response.headers}));
          throw new TrackingError('rate-limit', retry);
        }
        if (failures.some(value => value.status === 401 || value.status === 403 || value.message === 'Invalid token')) throw new TrackingError('auth');
        if (failures.some(value => typeof value.status === 'number' && value.status >= 500)) throw new TrackingError('unavailable');
        throw new TrackingError('invalid');
      }
      if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw new TrackingError('invalid');
      return object(payload.data);
    } catch (error) {
      throw error instanceof TrackingError ? error : new TrackingError('unavailable');
    }
  }
  async viewer(token: string): Promise<{id: number; name: string}> {
    if (!token) throw new TrackingError('auth');
    const raw = object((await this.request('query TrackingViewer { Viewer { id name } }', {}, token)).Viewer);
    if (!int(raw.id) || typeof raw.name !== 'string' || !raw.name.trim()) throw new TrackingError('invalid');
    return {id: raw.id, name: raw.name.trim().slice(0, 100)};
  }
  private async lookup(id: number, field: 'id' | 'idMal', token?: string): Promise<TrackingMedia> {
    requireId(id);
    const fields = `${mediaFields} idMal ${token ? `mediaListEntry { ${entryFields} }` : ''}`;
    const raw = object((await this.request(`query TrackingMedia($id: Int!) { Media(${field}: $id, type: MANGA) { ${fields} } }`, {id}, token)).Media);
    if (raw[field] !== id) throw new TrackingError('identity');
    return media(raw, Boolean(token));
  }
  media(mediaId: number, token?: string): Promise<TrackingMedia> { return this.lookup(mediaId, 'id', token); }
  mediaByMalId(malId: number, token?: string): Promise<TrackingMedia> { return this.lookup(malId, 'idMal', token); }
  async search(query: string): Promise<TrackingMedia[]> {
    const search = query.trim();
    if (!search || search.length > 300) throw new TrackingError('invalid');
    const result = object((await this.request(`query TrackingSearch($search: String!) {
      Page(page: 1, perPage: 10) { media(search: $search, type: MANGA, format_in: [MANGA, ONE_SHOT]) { ${mediaFields} } }
    }`, {search})).Page);
    if (!Array.isArray(result.media) || result.media.length > 10) throw new TrackingError('invalid');
    return result.media.map(value => media(value, false));
  }
  async save(value: {mediaId: number; listEntryId?: number; progress: number; status?: 'CURRENT'}, token: string): Promise<TrackingRemoteEntry> {
    requireId(value.mediaId);
    if (value.listEntryId !== undefined) requireId(value.listEntryId);
    if (!int(value.progress, 0) || (value.status !== undefined && value.status !== 'CURRENT')) throw new TrackingError('invalid');
    if (!token) throw new TrackingError('auth');
    // Omitted fields stay omitted (not null); no score, notes, dates, privacy or volumes.
    const identity = value.listEntryId === undefined ? 'mediaId' : 'id';
    const variables: Value = {[identity]: value.listEntryId ?? value.mediaId, progress: value.progress};
    if (value.status !== undefined) variables.status = value.status;
    const statusVariable = value.status === undefined ? '' : ', $status: MediaListStatus!';
    const statusArgument = value.status === undefined ? '' : ', status: $status';
    const data = await this.request(`mutation TrackingProgress($${identity}: Int!, $progress: Int!${statusVariable}) {
      SaveMediaListEntry(${identity}: $${identity}, progress: $progress${statusArgument}) { ${entryFields} }
    }`, variables, token);
    const result = entry(data.SaveMediaListEntry, value.mediaId);
    if (value.listEntryId !== undefined && result.id !== value.listEntryId) throw new TrackingError('identity');
    if (result.progress < value.progress || (value.status !== undefined && result.status !== value.status)) throw new TrackingError('invalid');
    return result;
  }
}

export const aniListProvider = new AniListProvider();
