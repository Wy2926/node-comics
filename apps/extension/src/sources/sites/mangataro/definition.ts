import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://mangataro.org';
export const isOrigin = (url: URL) => url.origin === origin && !url.username && !url.password;
export const catalogKey = (slug: string) => 'mangataro:manga:' + slug;
export const catalogUrl = (slug: string) => `${origin}/manga/${encodeURIComponent(slug)}`;
export const chapterKey = (id: string) => 'mangataro:chapter:' + id;
export function location(url: URL) {
  if (!isOrigin(url)) return null;
  let path: string;
  try {path = decodeURIComponent(url.pathname);} catch {return null;}
  const match = /^\/(manga|read)\/([^/]+)(?:\/ch(-?\d+(?:-\d+)?)-([1-9]\d{0,15}))?\/?$/.exec(path);
  if (!match || (match[1] === 'read') !== !!match[4] || match[2].length > 512 || /[\s\u0000-\u001f\u007f/%?#\\]/u.test(match[2])) return null;
  return {slug: match[2], chapter: match[3]?.replace(/^(-?\d+)-(\d+)$/, '$1.$2'), id: match[4]};
}
export const definition: SourceDefinition = {
  id: 'mangataro', name: 'MangaTaro', installation,
  sites: [{id: 'mangataro', name: 'MangaTaro', url: origin + '/home', icon, adaptedOn: '2026-10-12',
    pricing: 'free', isRaw: false, isAdult: false, primaryLanguages: ['en'], contentTags: ['manga', 'manhwa', 'manhua', 'webtoon'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, completePageList: true, inline: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = location(url);
    return loc ? {sourceId: this.id, pageKey: loc.id ? chapterKey(loc.id) : catalogKey(loc.slug),
      kind: loc.id ? 'reader' : 'catalog', url: url.href, catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}}
      : {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
  },
};
