import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://nhentai.com';
const locales = new Set(['en', 'zh', 'id', 'fr', 'es', 'de', 'ru', 'hi', 'pt', 'ar']);
export interface ComicLocation {locale: string; slug: string; reader: boolean; page?: number}
const owns = (url: URL) => url.origin === origin && !url.username && !url.password;
export function comicLocation(url: URL): ComicLocation | null {
  if (!owns(url) || url.search || url.hash) return null;
  const match = /^\/([a-z]{2})\/comic\/([a-z0-9]+(?:-[a-z0-9]+)*)(\/(reader)(?:\/([1-9]\d*))?)?\/?$/.exec(url.pathname);
  if (!match || !locales.has(match[1]) || match[2].length > 512) return null;
  const page = match[5] ? Number(match[5]) : undefined;
  if (page !== undefined && (!Number.isSafeInteger(page) || page > 1500)) return null;
  return {locale: match[1], slug: match[2], reader: !!match[3], ...(page ? {page} : {})};
}
export const catalogKey = (slug: string) => `nhentaicom:comic:${slug}`;
export const readerKey = (slug: string) => `${catalogKey(slug)}:reader`;
export const catalogUrl = (loc: ComicLocation) => `${origin}/${loc.locale}/comic/${loc.slug}`;
export const readerUrl = (loc: ComicLocation) => `${catalogUrl(loc)}/reader`;

export const definition: SourceDefinition = {
  id: 'nhentaicom', name: 'nHentai.com', installation,
  sites: [{id: 'nhentaicom', name: 'nHentai.com', url: origin + '/en/hentai-comics', icon,
    adaptedOn: '2026-10-14', pricing: 'unknown', isRaw: false,
    contentTags: ['manga', 'doujin'], primaryLanguages: ['ja', 'en', 'zh']}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!owns(url)) return null;
    const loc = comicLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: `${this.id}:${url.href}`, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.reader ? readerKey(loc.slug) : catalogKey(loc.slug),
      kind: loc.reader ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc)}};
  },
};
