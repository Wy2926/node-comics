import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://nhentai.to';
export const maxPages = 1500;
const owns = (url: URL) => ['http:', 'https:'].includes(url.protocol) && url.hostname === 'nhentai.to'
  && !url.port && !url.username && !url.password;
export interface GalleryLocation {id: string; page?: number}
export function galleryLocation(url: URL): GalleryLocation | null {
  if (!owns(url) || url.search || url.hash) return null;
  const match = /^\/g\/([1-9]\d{0,11})(?:\/([1-9]\d{0,3}))?\/?$/.exec(url.pathname);
  if (!match) return null;
  const page = match[2] ? Number(match[2]) : undefined;
  return page !== undefined && page > maxPages ? null : {id: match[1], ...(page ? {page} : {})};
}
export const catalogKey = (id: string) => `nhentaito:gallery:${id}`;
export const readerKey = (id: string) => `${catalogKey(id)}:reader`;
export const catalogUrl = (id: string) => `${origin}/g/${id}/`;
export const readerUrl = (id: string, page = 1) => `${catalogUrl(id)}${page}/`;

export const definition: SourceDefinition = {
  id: 'nhentaito', name: 'nHentai.to', installation,
  sites: [{id: 'nhentaito', name: 'nHentai.to', url: origin + '/', icon, adaptedOn: '2026-10-29',
    pricing: 'free', isRaw: false, isAdult: true, contentTags: ['manga', 'doujin'], primaryLanguages: ['ja', 'en', 'zh']}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!owns(url)) return null;
    const loc = galleryLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: `${this.id}:${url.href}`, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.page ? readerKey(loc.id) : catalogKey(loc.id),
      kind: loc.page ? 'reader' : 'catalog', url: url.href, catalog: {key: catalogKey(loc.id), url: catalogUrl(loc.id)}};
  },
};
