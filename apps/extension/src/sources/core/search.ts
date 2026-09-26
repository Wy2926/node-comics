import type {SourceDefinition, SourceSite} from '../contracts/definition';
import {SourceSearchError, type SourceSearchCapability,
  type SourceSearchHit, type SourceSearchPage, type SourceSearchRequest, type SourceSearchResult} from '../contracts/search';
import {resolveSource} from './resolve';
import {safeImageUrl} from '../shared/urls';
import {originMatches} from '../shared/origins';

export const sourceSearchLimits = {queryCharacters: 256, pageItems: 50, cursorCharacters: 4096, pageTimeoutMs: 15_000} as const;
const invalid = (): never => {throw new SourceSearchError('SOURCE_SEARCH_INVALID');};
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() &&
  [...value].length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

export function normalizeSearchLanguage(value: string): string {
  if (!text(value, 80)) return invalid();
  try {return Intl.getCanonicalLocales(value)[0] || invalid();} catch {return invalid();}
}
export function normalizeSourceSearchRequest(input: SourceSearchRequest): SourceSearchRequest {
  if (!input || !text(input.siteId, 128) || !text(input.query, sourceSearchLimits.queryCharacters) ||
    input.cursor !== undefined && !text(input.cursor, sourceSearchLimits.cursorCharacters)) return invalid();
  return {siteId: input.siteId, query: input.query.trim(),
    ...(input.cursor === undefined ? {} : {cursor: input.cursor})};
}

function originPatternContained(pattern: string, declared: string): boolean {
  const parts = /^(https?|\*):\/\/(\*|\*\.[^/*:]+|[^/*:]+)(?::(\d+))?\/\*$/.exec(pattern);
  if (!parts) return false;
  const protocols = parts[1] === '*' ? ['http', 'https'] : [parts[1]];
  const host = parts[2], port = parts[3] ? ':' + parts[3] : '';
  if (host === '*') return declared === pattern || declared === '*://*/*';
  // Wildcard requests must also be covered for arbitrary descendants.
  return protocols.every(protocol => originMatches(declared, `${protocol}://${host.replace(/^\*\./, '')}${port}/`) &&
    (!host.startsWith('*.') || originMatches(declared, `${protocol}://search-permission-check.${host.slice(2)}${port}/`)));
}
export function validateSearchCapability(definition: SourceDefinition, site: SourceSite): SourceSearchCapability {
  const capability = site.search;
  if (!capability || !definition.capabilities.importable || !definition.capabilities.catalog ||
    !Array.isArray(capability.requestOrigins) || !capability.requestOrigins.length || capability.requestOrigins.length > 16) return invalid();
  const declared = [...definition.installation.requiredOrigins, ...(definition.installation.optionalOrigins ?? [])];
  if (capability.requestOrigins.some(origin => !declared.some(allowed => originPatternContained(origin, allowed)))) return invalid();
  return capability;
}
function stringList(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => !text(item, maxLength))) return invalid();
  return [...new Set(value.map(item => item.trim()))];
}
/** Search observations never grant source authority or create a catalog/library record. */
export function validateSearchPage(input: unknown, definition: SourceDefinition, site: SourceSite,
  registry: readonly SourceDefinition[]): {items: SourceSearchResult[]; nextCursor?: string} {
  validateSearchCapability(definition, site);
  const page = input as SourceSearchPage;
  if (!page || !Array.isArray(page.items) || page.items.length > sourceSearchLimits.pageItems ||
    page.nextCursor !== undefined && !text(page.nextCursor, sourceSearchLimits.cursorCharacters)) return invalid();
  const items = new Map<string, SourceSearchResult>();
  for (const raw of page.items) {
    if (!raw || !text(raw.catalogId, 2048) || !text(raw.catalogUrl, 8192) || !text(raw.title, 1024) ||
      raw.latestLabel !== undefined && !text(raw.latestLabel, 512)) return invalid();
    const resolved = resolveSource(raw.catalogUrl, registry);
    if (resolved.definition.id !== definition.id || resolved.location.kind !== 'catalog' || resolved.location.catalog?.key !== raw.catalogId) return invalid();
    if (raw.cover !== undefined && (!raw.cover || !text(raw.cover.url, 8192) || safeImageUrl(raw.cover.url, raw.catalogUrl) !== raw.cover.url)) return invalid();
    const languages = stringList(raw.contentLanguages, 200, 80)?.map(normalizeSearchLanguage);
    const hit: SourceSearchHit = {catalogId: raw.catalogId, catalogUrl: resolved.location.url, title: raw.title.trim(),
      authors: stringList(raw.authors, 30, 180), ...(languages?.length ? {contentLanguages: [...new Set(languages)]} : {}),
      cover: raw.cover ? {url: raw.cover.url} : undefined, latestLabel: raw.latestLabel?.trim()};
    const key = JSON.stringify([definition.id, hit.catalogId]);
    items.set(key, {...hit, sourceId: definition.id, siteId: site.id, key});
  }
  return {items: [...items.values()], ...(page.nextCursor === undefined ? {} : {nextCursor: page.nextCursor})};
}
