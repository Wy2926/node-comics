import type {SourceDefinition} from '../../contracts/definition';
import type {MangaThemesiaLocation} from '../../shared/mangathemesia/config';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://undertranslations.com';
const validSlug = (value: string) => value.length <= 512 && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\.\d+)?$/.test(value);
export const catalogKey = (slug: string) => 'undertranslations:manga:' + encodeURIComponent(slug);
export const chapterKey = (slug: string) => 'undertranslations:chapter:' + encodeURIComponent(slug);
export const catalogUrl = (slug: string) => `${origin}/manga/${encodeURIComponent(slug)}/`;
export const chapterUrl = (slug: string, catalogSlug?: string) => `${origin}/${encodeURIComponent(slug)}/${catalogSlug
  ? '#nodelane-undertranslations=' + encodeURIComponent(catalogSlug) : ''}`;
export function location(url: URL): MangaThemesiaLocation | null {
  if (url.origin !== origin || url.username || url.password || url.search) return null;
  let path: string;
  try {path = decodeURIComponent(url.pathname);} catch {return null;}
  const catalog = /^\/manga\/([^/]+)\/?$/.exec(path);
  if (catalog) return validSlug(catalog[1]) && !url.hash ? {catalogSlug: catalog[1]} : null;
  const chapter = /^\/([^/]+)\/?$/.exec(path);
  if (!chapter || !validSlug(chapter[1]) || !/-capitulo-\d+(?:[.-]\d+)?$/i.test(chapter[1])) return null;
  const binding = /^#nodelane-undertranslations=([^&#]+)$/.exec(url.hash);
  if (url.hash && !binding) return null;
  let catalogSlug: string | undefined;
  if (binding) {
    try {catalogSlug = decodeURIComponent(binding[1]);} catch {return null;}
    if (!validSlug(catalogSlug)) return null;
  }
  return {chapterSlug: chapter[1], ...(catalogSlug ? {catalogSlug} : {})};
}
export const definition: SourceDefinition = {
  id: 'undertranslations', name: 'UnderTranslations', installation,
  sites: [{id: 'undertranslations', name: 'UnderTranslations', url: origin + '/', icon, adaptedOn: '2026-10-15',
    pricing: 'unknown', contentTags: ['manga'], isRaw: false, primaryLanguages: ['es'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapterSlug ? chapterKey(loc.chapterSlug) : catalogKey(loc.catalogSlug!),
      kind: loc.chapterSlug ? 'reader' : 'catalog', url: url.href,
      ...(loc.catalogSlug ? {catalog: {key: catalogKey(loc.catalogSlug), url: catalogUrl(loc.catalogSlug)}} : {})};
  },
};
