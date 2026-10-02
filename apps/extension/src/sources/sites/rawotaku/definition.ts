import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://rawotaku.com';
export interface RawLocation {slug: string; language?: string; chapter?: string}
export function rawLocation(url: URL): RawLocation | null {
  if (url.origin !== origin || url.username || url.password) return null;
  let path: string;
  try {path = decodeURIComponent(url.pathname);} catch {return null;}
  if (/[\\%\u0000-\u001f\u007f]/u.test(path)) return null;
  const reader = /^\/read\/([^/]+)\/([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\/chapter-(\d+(?:\.\d+)?)-raw\/?$/.exec(path);
  if (reader && reader[1].length <= 512 && reader[3].length <= 40) {
    try {Intl.getCanonicalLocales(reader[2]);} catch {return null;}
    return {slug: reader[1], language: reader[2], chapter: reader[3]};
  }
  const catalog = /^\/read\/([^/]+)-raw\/?$/.exec(path);
  return catalog && catalog[1].length <= 512 ? {slug: catalog[1]} : null;
}
export const catalogKey = (slug: string) => 'rawotaku:' + slug;
export const catalogUrl = (slug: string) => `${origin}/read/${encodeURIComponent(slug)}-raw/`;
export const chapterKey = (loc: RawLocation) => `${catalogKey(loc.slug)}:${loc.language}:chapter:${loc.chapter}`;
export const chapterUrl = (loc: RawLocation) => `${origin}/read/${encodeURIComponent(loc.slug)}/${loc.language}/chapter-${loc.chapter}-raw/`;
export const definition: SourceDefinition = {
  id: 'rawotaku', name: 'RawOtaku', installation,
  sites: [{id: 'rawotaku', name: 'RawOtaku', url: origin + '/', icon, primaryLanguages: ['ja'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = rawLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'rawotaku:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
