import {SourceSearchError, type SourceSearchOptions, type SourceSearchRequest, type SourceSearchResult,
  type SourceSearchResults, type SourceSearchSite} from '../contracts/search';
import {normalizeSourceSearchRequest, sourceSearchLimits, validateSearchCapability, validateSearchPage} from '../core/search';
import {definitions} from '../registry/definitions';
import {sourceNetworks} from '../registry/networks';
import {createSourceNetworkContext, SourceHttpError} from './http';
import {readSourceArtwork} from './source-image';
import {withSearchNetworkContext} from './page-network';
import type {SourceNetworkContext} from '../contracts/network';

const lifetimeMs = 10 * 60_000;
const cursors = new Map<string, {binding: string; value: string; sessionId: string; expires: number}>();
const covers = new Map<string, {hit: SourceSearchResult; expires: number}>();
const pending = new Map<string, Set<AbortController>>();
const coverKey = (hit: SourceSearchResult) => JSON.stringify([hit.sourceId, hit.siteId, hit.catalogId, hit.catalogUrl, hit.cover?.url]);
function prune() {
  for (const [key, value] of cursors) if (value.expires <= Date.now()) cursors.delete(key);
  for (const [key, value] of covers) if (value.expires <= Date.now()) covers.delete(key);
  while (cursors.size > 512) cursors.delete(cursors.keys().next().value!);
  while (covers.size > 1000) covers.delete(covers.keys().next().value!);
}
function authority(sourceId: string, siteId: string) {
  const definition = definitions.find(value => value.id === sourceId), site = definition?.sites?.find(value => value.id === siteId);
  const operation = sourceNetworks[sourceId]?.search;
  if (!definition || !site?.search || site.isAdult !== false || !operation) throw new SourceSearchError('SOURCE_SEARCH_UNSUPPORTED');
  return {definition, site, operation, searchPage: sourceNetworks[sourceId]?.searchPage, capability: validateSearchCapability(definition, site)};
}
export function listSearchSites(): SourceSearchSite[] {
  return definitions.flatMap(definition => (definition.sites ?? []).flatMap(site => {
    if (!site.search || site.isAdult !== false) return [];
    const {capability} = authority(definition.id, site.id);
    return [{...site, adapterId: definition.id, key: `${definition.id}:${site.id}`, search: capability}];
  }));
}
/** Disposal prevents late adapter responses from issuing tokens, even when an adapter ignores cancellation. */
export function releaseSourceSearchSession(sessionId: string): void {
  for (const controller of pending.get(sessionId) ?? []) controller.abort();
  pending.delete(sessionId);
  for (const [key, value] of cursors) if (value.sessionId === sessionId) cursors.delete(key);
}
function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted();
    value.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
export async function searchSource(sourceId: string, input: SourceSearchRequest, options: SourceSearchOptions): Promise<SourceSearchResults> {
  options.signal?.throwIfAborted();
  if (typeof options.sessionId !== 'string' || !options.sessionId || options.sessionId.length > 200) throw new SourceSearchError('SOURCE_SEARCH_INVALID');
  const request = normalizeSourceSearchRequest(input), {definition, site, operation, searchPage} = authority(sourceId, request.siteId);
  prune();
  const binding = JSON.stringify([options.sessionId, sourceId, site.id, request.query]);
  let cursor: string | undefined;
  if (request.cursor !== undefined) {
    const registered = cursors.get(request.cursor);
    if (!registered || registered.binding !== binding) throw new SourceSearchError('SOURCE_SEARCH_CURSOR_EXPIRED');
    cursor = registered.value;
  }
  const controller = new AbortController();
  const controllers = pending.get(options.sessionId) ?? new Set<AbortController>();
  controllers.add(controller); pending.set(options.sessionId, controllers);
  const timer = setTimeout(() => controller.abort(new SourceSearchError('SOURCE_SEARCH_TIMEOUT')), sourceSearchLimits.pageTimeoutMs);
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  let sourceUrl: string | undefined;
  try {
    const adapterRequest = {...request, cursor};
    sourceUrl = searchPage?.(adapterRequest);
    const read = async (context: SourceNetworkContext) => {
      const transport = async <T>(request: () => Promise<T>) => {
        try { return await request(); }
        catch (error) {
          if (signal.aborted || error instanceof SourceHttpError) throw error;
          throw new SourceHttpError('http', 'Source search transport failed');
        }
      };
      try { return await operation(adapterRequest, {...context,
        request: (...args) => transport(() => context.request(...args)),
        ...(context.requestBytes ? {requestBytes: (...args: Parameters<NonNullable<SourceNetworkContext['requestBytes']>>) => transport(() => context.requestBytes!(...args))} : {}),
      }); }
      catch (error) {
        if (signal.aborted || error instanceof SourceSearchError || error instanceof SourceHttpError) throw error;
        // A successful response whose packaged parser rejects it is not a network outage.
        throw new SourceSearchError('SOURCE_SEARCH_INVALID');
      }
    };
    const raw = await abortable(sourceUrl ? withSearchNetworkContext(sourceUrl, signal, read)
      : read(createSourceNetworkContext(signal)), signal);
    signal.throwIfAborted();
    const page = validateSearchPage(raw, definition, site, definitions);
    signal.throwIfAborted();
    let nextCursor: string | undefined;
    if (page.nextCursor !== undefined && page.nextCursor !== cursor) {
      nextCursor = crypto.randomUUID();
      cursors.set(nextCursor, {binding, value: page.nextCursor, sessionId: options.sessionId, expires: Date.now() + lifetimeMs});
    }
    for (const hit of page.items) if (hit.cover) covers.set(coverKey(hit), {hit, expires: Date.now() + lifetimeMs});
    prune();
    return {items: page.items, ...(nextCursor ? {nextCursor} : {})};
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof SourceSearchError) throw sourceUrl ? new SourceSearchError(error.code, error.retryAfter, sourceUrl) : error;
    if (error instanceof SourceHttpError) {
      const {status, retryAfter} = error.details;
      throw new SourceSearchError(error.kind === 'request-denied' ? 'SOURCE_SEARCH_REQUEST_DENIED' :
        error.kind === 'permission-required' ? 'SOURCE_SEARCH_PERMISSION_REQUIRED' :
        error.kind === 'verification-required' ? 'SOURCE_SEARCH_VERIFICATION_REQUIRED' :
        error.kind === 'invalid-response' ? 'SOURCE_SEARCH_INVALID' :
        status === 429 ? 'SOURCE_SEARCH_RATE_LIMITED' :
        status === 401 ? 'SOURCE_SEARCH_LOGIN_REQUIRED' :
        status === 403 ? 'SOURCE_SEARCH_FORBIDDEN' : 'SOURCE_SEARCH_HTTP_ERROR', retryAfter, sourceUrl);
    }
    throw new SourceSearchError('SOURCE_SEARCH_HTTP_ERROR');
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
    if (!controllers.size && pending.get(options.sessionId) === controllers) pending.delete(options.sessionId);
  }
}
/** Only a candidate observed by this runtime may supply cover metadata; no fake catalog snapshot. */
export async function readSearchCover(hit: SourceSearchResult, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  prune();
  const registered = covers.get(coverKey(hit));
  if (!registered || registered.hit.key !== hit.key || !registered.hit.cover) throw new SourceSearchError('SOURCE_SEARCH_INVALID');
  const verified = registered.hit;
  authority(verified.sourceId, verified.siteId);
  return readSourceArtwork(verified.sourceId,verified.cover!.url,verified.catalogUrl,signal);
}
