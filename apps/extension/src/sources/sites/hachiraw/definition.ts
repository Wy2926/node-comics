import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://hachiraw.net';
export const isOrigin = (url: URL) => url.origin === origin && !url.username && !url.password;
export interface HachiLocation {slug: string; chapter?: string}
export function hachiLocation(url: URL): HachiLocation | null {
  if (!isOrigin(url) || url.search || url.hash) return null;
  let path: string;
  try {path = decodeURIComponent(url.pathname);} catch {return null;}
  // Keep source release IDs intact, including corrected chapters and legacy 250-raw links.
  const match = /^\/manga\/([^/]+)(?:\/(chapter-\d+(?:-[a-z0-9]+)*|\d+-raw))?\/?$/.exec(path);
  if (!match || match[1].length > 512 || /[\u0000-\u0020\u007f/%?#\\]/u.test(match[1]) || (match[2]?.length ?? 0) > 80) return null;
  return {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})};
}
export const catalogKey = (slug: string) => 'hachiraw:manga:' + encodeURIComponent(slug);
export const catalogUrl = (slug: string) => `${origin}/manga/${encodeURIComponent(slug)}`;
export const chapterKey = (loc: HachiLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`;
export const chapterUrl = (loc: HachiLocation) => `${catalogUrl(loc.slug)}/${loc.chapter}`;
export const definition: SourceDefinition = {
  id: 'hachiraw', name: 'Hachiraw', installation,
  sites: [{id: 'hachiraw', name: 'Hachiraw', url: origin + '/', icon, adaptedOn: '2026-10-12', pricing: 'free', isRaw: true, isAdult: false,
    contentTags: ['manga'], primaryLanguages: ['ja'], search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = hachiLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
