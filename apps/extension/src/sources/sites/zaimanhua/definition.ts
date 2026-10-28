import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const originalOrigin = 'https://www.zaimanhua.com';
export const mangaOrigin = 'https://manhua.zaimanhua.com';
export type Area = 'original' | 'manga';
export interface ZaiLocation {area: Area; slug?: string; comic?: string; chapter?: string}
export const validId = (value: string) => /^[1-9]\d{0,9}$/.test(value);
export const validSlug = (value: string) => /^[a-zA-Z0-9_-]{1,200}$/.test(value);
export function siteOrigin(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  if (url.hostname === 'www.zaimanhua.com') return originalOrigin;
  if (url.hostname === 'manhua.zaimanhua.com') return mangaOrigin;
  return null;
}
export function location(url: URL): ZaiLocation | null {
  const origin = siteOrigin(url);
  if (!origin) return null;
  const area: Area = origin === originalOrigin ? 'original' : 'manga';
  const reader = /^\/view\/([a-zA-Z0-9_-]{1,200})\/([1-9]\d{0,9})\/([1-9]\d{0,9})\/?$/.exec(url.pathname);
  if (reader) return {area, slug: reader[1], comic: reader[2], chapter: reader[3]};
  if (area === 'manga') {
    const detail = /^\/details\/([1-9]\d{0,9})\/?$/.exec(url.pathname);
    return detail ? {area, comic: detail[1]} : null;
  }
  const detail = /^\/(?:info|details\/[^/]+)\/([a-zA-Z0-9_-]{1,200})\.html$/.exec(url.pathname);
  return detail ? {area, slug: detail[1]} : null;
}
export const originFor = (loc: ZaiLocation) => loc.area === 'original' ? originalOrigin : mangaOrigin;
export const catalogKey = (loc: ZaiLocation) => `zaimanhua:${loc.area}:${loc.area === 'original' ? loc.slug : loc.comic}`;
export const catalogUrl = (loc: ZaiLocation) => originFor(loc) + (loc.area === 'original' ? `/info/${loc.slug}.html` : `/details/${loc.comic}`);
export const chapterKey = (loc: ZaiLocation) => `${catalogKey(loc)}:comic:${loc.comic}:chapter:${loc.chapter}`;
export const chapterUrl = (loc: ZaiLocation) => `${originFor(loc)}/view/${loc.slug}/${loc.comic}/${loc.chapter}`;
export const definition: SourceDefinition = {
  id: 'zaimanhua', name: '再漫画', installation,
  sites: [
    {id: 'zaimanhua', name: '再漫画 · 原创', url: originalOrigin + '/', icon, adaptedOn: '2026-10-12', pricing: 'freemium', isRaw: false, isAdult: false, primaryLanguages: ['zh-Hans'], contentTags: ['manhua'], search: true},
    {id: 'zaimanhua-manga', name: '再漫画 · 日漫', url: mangaOrigin + '/', icon, adaptedOn: '2026-10-12', pricing: 'freemium', isRaw: false, isAdult: false, primaryLanguages: ['zh-Hans'], contentTags: ['manga'], search: true},
  ],
  capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!siteOrigin(url)) return null;
    const loc = location(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc), kind: loc.chapter ? 'reader' : 'catalog',
      url: url.href, catalog: {key: catalogKey(loc), url: catalogUrl(loc)}};
  },
};
