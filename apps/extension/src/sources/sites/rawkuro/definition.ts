import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origins = {rawkuro: 'https://rawkuro.net', raw1001: 'https://raw1001.net'};
const isOrigin = (url: URL) => Object.values(origins).includes(url.origin) && !url.username && !url.password;
interface RawLocation {origin: string; slug: string; chapter?: string}
export function rawLocation(url: URL): RawLocation | null {
  if (!isOrigin(url) || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) return null;
  let path: string;
  try {path = decodeURIComponent(url.pathname);} catch {return null;}
  const match = /^\/manga\/([\p{L}\p{N}][\p{L}\p{N}_-]*)(?:\/([\p{L}\p{N}][\p{L}\p{N}_-]*))?\/?$/u.exec(path);
  if (!match || match[1].length > 512 || (match[2]?.length ?? 0) > 512) return null;
  return {origin: url.origin, slug: match[1], ...(match[2] ? {chapter: match[2]} : {})};
}
// Both domains expose the same work slugs, chapter slugs and numeric API identities.
export const catalogKey = (loc: RawLocation) => 'rawkuro:manga:' + encodeURIComponent(loc.slug);
export const catalogUrl = (loc: RawLocation) => `${loc.origin}/manga/${encodeURIComponent(loc.slug)}`;
export const chapterKey = (loc: RawLocation) => `${catalogKey(loc)}:${encodeURIComponent(loc.chapter!)}`;
export const chapterUrl = (loc: RawLocation) => `${catalogUrl(loc)}/${encodeURIComponent(loc.chapter!)}`;
export const definition: SourceDefinition = {
  id: 'rawkuro', name: 'RawKuro / Raw1001', installation,
  sites: Object.entries(origins).map(([id, origin]) => ({id, name: id === 'rawkuro' ? 'RawKuro' : 'Raw1001',
    url: origin + '/', icon, adaptedOn: '2026-10-14', pricing: 'free', isRaw: true,
    contentTags: ['manga'], primaryLanguages: ['ja'], search: true})),
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (!isOrigin(url)) return null;
    const loc = rawLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href, catalog: {key: catalogKey(loc), url: catalogUrl(loc)}};
  },
};
