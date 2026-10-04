import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://mangapill.com';
export interface MangapillLocation {work: string; chapter?: string; slug?: string; catalogSlug?: string}
export function mangapillLocation(url: URL): MangapillLocation | null {
  if (url.origin !== origin || url.username || url.password) return null;
  const catalog = /^\/manga\/([1-9]\d{0,11})(?:\/([a-zA-Z0-9._-]+))?\/?$/.exec(url.pathname);
  if (catalog && (!catalog[2] || catalog[2].length <= 512)) return {work: catalog[1], slug: catalog[2]};
  const reader = /^\/chapters\/([1-9]\d{0,11})-(\d{1,16})(?:\/([a-zA-Z0-9._-]+))?\/?$/.exec(url.pathname);
  if (!reader || (reader[3] && reader[3].length > 512)) return null;
  const binding = /^#nodelane-mangapill=([a-zA-Z0-9._-]{1,512})$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-mangapill') && !binding) return null;
  return {work: reader[1], chapter: reader[2], slug: reader[3], catalogSlug: binding?.[1]};
}
export const catalogKey = (work: string) => 'mangapill:' + work;
export const catalogUrl = (work: string, slug?: string) => `${origin}/manga/${work}${slug ? '/' + slug : ''}`;
export const chapterKey = (loc: MangapillLocation) => `${catalogKey(loc.work)}:chapter:${loc.chapter}`;
export const chapterUrl = (loc: MangapillLocation, catalogSlug?: string) =>
  `${origin}/chapters/${loc.work}-${loc.chapter}${loc.slug ? '/' + loc.slug : ''}${catalogSlug ? '#nodelane-mangapill=' + catalogSlug : ''}`;
export const definition: SourceDefinition = {
  id: 'mangapill', name: 'MangaPill', installation,
  sites: [{id: 'mangapill', name: 'MangaPill', url: origin + '/', icon, adaptedOn: '2026-10-03', isFree: true, contentTags: ['manga'], primaryLanguages: ['en'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = mangapillLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'mangapill:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.work),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      ...(!loc.chapter || loc.catalogSlug ? {catalog: {key: catalogKey(loc.work), url: catalogUrl(loc.work, loc.chapter ? loc.catalogSlug : loc.slug)}} : {})};
  },
};
