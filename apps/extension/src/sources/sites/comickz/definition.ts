import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://comickz.co.uk';
export const validSlug = (value: string) => /^[a-zA-Z0-9_-]{1,512}$/.test(value);
export const catalogKey = (slug: string) => 'comickz:' + slug;
export const catalogUrl = (slug: string) => `${origin}/comic/${slug}`;
export const chapterKey = (hid: string) => 'comickz:chapter:' + hid;
export function location(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/comic\/([a-zA-Z0-9_-]{1,512})(?:\/([a-zA-Z0-9_-]{1,64})-chapter-(-?\d+(?:\.\d+)?|null)-([a-z]{2,3}(?:-[a-z0-9]{2,8})*))?\/?$/.exec(url.pathname);
  return match ? {slug: match[1], hid: match[2], chap: match[3], lang: match[4]} : null;
}
export const definition: SourceDefinition = {
  id: 'comickz', name: 'ComicK (comickz)', installation,
  sites: [{id: 'comickz', name: 'ComicK (comickz)', url: origin + '/home', icon, adaptedOn: '2026-10-09',
    primaryLanguages: ['en'], contentTags: ['manga', 'manhwa', 'manhua'], search: true}],
  capabilities: {importable: true, catalog: true, pages: true, completePageList: true, inline: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    return loc ? {sourceId: this.id, pageKey: loc.hid ? chapterKey(loc.hid) : catalogKey(loc.slug),
      kind: loc.hid ? 'reader' : 'catalog', url: url.href, catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}}
      : {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
  },
};
