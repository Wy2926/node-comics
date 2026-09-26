import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://mangadot.net';
export type ReleaseKind = 'chapter' | 'volume';
export type ReleaseSource = 'scraper' | 'user';
export const catalogUrl = (id: string) => `${origin}/manga/${id}`;
export const releaseKey = (id: string, source: ReleaseSource, kind: ReleaseKind) => `mangadot:${source}:${kind}:${id}`;
export function releaseUrl(id: string, source: ReleaseSource, kind: ReleaseKind, mangaId?: string) {
  return `${origin}/${kind}/${id}${kind === 'chapter' && source === 'user' ? '?source=user' : ''}${mangaId ? '#nodelane-mangadot=' + mangaId : ''}`;
}
export function mangaDotLocation(url: URL) {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/(manga|chapter|volume)\/([1-9]\d{0,12})\/?$/.exec(url.pathname);
  if (!match) return null;
  if (match[1] === 'manga') return {mangaId: match[2], release: undefined};
  const sources = url.searchParams.getAll('source');
  if (sources.length > 1 || sources.some(value => !['user', 'scraper'].includes(value)) || match[1] === 'volume' && sources.includes('scraper')) return null;
  const binding = /^#nodelane-mangadot=([1-9]\d{0,12})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-mangadot') && !binding) return null;
  return {mangaId: binding?.[1], release: {id: match[2], kind: match[1] as ReleaseKind,
    source: (match[1] === 'volume' || sources[0] === 'user' ? 'user' : 'scraper') as ReleaseSource}};
}
export const definition: SourceDefinition = {
  id: 'mangadot', name: 'MangaDot', installation,
  sites: [{id: 'mangadot', name: 'MangaDot', url: origin + '/', icon, primaryLanguages: ['en', 'fr', 'es'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = mangaDotLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: this.id + ':' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.release ? releaseKey(loc.release.id, loc.release.source, loc.release.kind) : `mangadot:${loc.mangaId}`,
      kind: loc.release ? 'reader' : 'catalog', url: url.href,
      ...(loc.mangaId ? {catalog: {key: 'mangadot:' + loc.mangaId, url: catalogUrl(loc.mangaId)}} : {})};
  },
};
