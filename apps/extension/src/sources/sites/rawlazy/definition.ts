import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://rawlazy.io';
export interface RawLocation {catalogSlug?: string; chapterSlug?: string}
const validSlug = (value: string) => value.length > 0 && value.length <= 512 && !/[\s/%?#\\\u0000-\u001f\u007f]/u.test(value);
export const catalogKey = (slug: string) => 'rawlazy:manga:' + encodeURIComponent(slug);
export const chapterKey = (slug: string) => 'rawlazy:chapter:' + encodeURIComponent(slug);
export const catalogUrl = (slug: string) => `${origin}/manga-lazy/${encodeURIComponent(slug)}/`;
export const chapterUrl = (slug: string, catalogSlug?: string) => `${origin}/${encodeURIComponent(slug)}/${catalogSlug
  ? '#nodelane-rawlazy=' + encodeURIComponent(catalogSlug) : ''}`;
export function rawLocation(url: URL): RawLocation | null {
  if (url.origin !== origin || url.username || url.password || url.search) return null;
  let path: string;
  try {path = decodeURIComponent(url.pathname);} catch {return null;}
  const catalog = /^\/manga-lazy\/([^/]+)\/?$/.exec(path);
  if (catalog) return validSlug(catalog[1]) && !url.hash ? {catalogSlug: catalog[1]} : null;
  const chapter = /^\/([^/]+)\/?$/.exec(path);
  if (!chapter || !validSlug(chapter[1]) || /^(?:wp-|feed$|search$|robots\.txt$|sitemap|favicon|about$|contact$|privacy|terms)/i.test(chapter[1])) return null;
  let catalogSlug: string | undefined;
  if (url.hash.startsWith('#nodelane-rawlazy')) {
    const binding = /^#nodelane-rawlazy=([^&#]+)$/.exec(url.hash);
    if (!binding) return null;
    try {catalogSlug = decodeURIComponent(binding[1]);} catch {return null;}
    if (!validSlug(catalogSlug)) return null;
  }
  // Bare legacy posts use Japanese slugs, sometimes without a chapter suffix.
  // A catalog-bound URL also admits an ASCII legacy slug verified by that catalog.
  if (!catalogSlug && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(chapter[1]) && !/(?:^|-)raw(?:-|$)/i.test(chapter[1])) return null;
  return {catalogSlug, chapterSlug: chapter[1]};
}
/** Catalog membership supplies the binding for legacy posts; never derive it from a post title. */
export function boundChapterLocation(url: URL, catalogSlug: string): RawLocation | null {
  const bound = new URL(url);
  if (!bound.hash) bound.hash = 'nodelane-rawlazy=' + encodeURIComponent(catalogSlug);
  const loc = rawLocation(bound);
  return loc?.chapterSlug && loc.catalogSlug === catalogSlug ? loc : null;
}
export const definition: SourceDefinition = {
  id: 'rawlazy', name: 'RawLazy', installation,
  sites: [{id: 'rawlazy', name: 'RawLazy', url: origin + '/', icon, adaptedOn: '2026-10-04', isFree: true, contentTags: ['manga', 'doujin'], primaryLanguages: ['ja'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = rawLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapterSlug ? chapterKey(loc.chapterSlug) : catalogKey(loc.catalogSlug!),
      kind: loc.chapterSlug ? 'reader' : 'catalog', url: url.href,
      ...(loc.catalogSlug ? {catalog: {key: catalogKey(loc.catalogSlug), url: catalogUrl(loc.catalogSlug)}} : {})};
  },
};
