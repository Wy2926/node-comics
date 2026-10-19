import type {SourceDefinition} from '../../contracts/definition';
import icon from './icon.svg?inline';
import installation from './installation.json';

export const origin = 'https://asurascans.com';
export const catalogKey = (work: string) => 'asurascans:' + work;
export const chapterKey = (work: string, chapter: string) => catalogKey(work) + ':chapter:' + chapter;
export function isOrigin(url: URL) {
  return url.origin === origin && !url.username && !url.password;
}
export function asuraLocation(url: URL) {
  if (!isOrigin(url) || url.search || url.hash) return null;
  // The public suffix rotates; the SSR seriesSlug and canonical redirect prove the stable work slug.
  const match = /^\/comics\/(([a-z0-9]+(?:-[a-z0-9]+)*)-[a-z0-9]{8})(?:\/chapter\/(0|[1-9]\d*)(\.\d*[1-9])?)?\/?$/.exec(url.pathname);
  if (!match || match[2].length > 200) return null;
  return {work: match[2], publicSlug: match[1], chapter: match[3] === undefined ? undefined : match[3] + (match[4] ?? ''),
    catalogUrl: origin + '/comics/' + match[1]};
}
export const definition: SourceDefinition = {
  id: 'asurascans', name: 'Asura Scans', installation,
  sites: [{id: 'asurascans', name: 'Asura Scans', url: origin + '/', icon, adaptedOn: '2026-10-19',
    pricing: 'freemium', isRaw: false, contentTags: ['manga', 'manhwa', 'manhua', 'webtoon'],
    primaryLanguages: ['en'], accessTags: ['login-required'], search: true}],
  capabilities: {importable: true, pages: true, catalog: true, inline: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = asuraLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter === undefined ? catalogKey(loc.work) : chapterKey(loc.work, loc.chapter),
      kind: loc.chapter === undefined ? 'catalog' : 'reader', url: url.href,
      catalog: {key: catalogKey(loc.work), url: loc.catalogUrl}};
  },
};
