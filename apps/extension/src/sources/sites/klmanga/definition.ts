import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://klmanga.zone';
export interface KlLocation {slug: string; chapter?: string}
const validSlug = (value: string) => value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f/%?#\\]/u.test(value);
export function klLocation(url: URL): KlLocation | null {
  if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null;
  let path: string;
  try {path = decodeURIComponent(url.pathname);} catch {return null;}
  const match = /^\/manga-raw\/([^/]+)(?:\/(chapter-\d+(?:-\d+)*))?\/?$/.exec(path);
  return match && validSlug(match[1]) && (!match[2] || match[2].length <= 80)
    ? {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})} : null;
}
export const catalogKey = (slug: string) => 'klmanga:manga:' + encodeURIComponent(slug);
export const catalogUrl = (slug: string) => `${origin}/manga-raw/${encodeURIComponent(slug)}/`;
export const chapterKey = (loc: KlLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`;
export const chapterUrl = (loc: KlLocation) => `${catalogUrl(loc.slug)}${loc.chapter}/`;
export const definition: SourceDefinition = {
  id: 'klmanga', name: 'KLManga', installation,
  sites: [{id: 'klmanga', name: 'KLManga', url: origin + '/', icon, primaryLanguages: ['ja'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = klLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
