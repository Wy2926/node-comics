import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://mangadna.com';
export interface MangaDnaLocation {slug: string; chapter?: string}
export function mangaDnaLocation(url: URL): MangaDnaLocation | null {
  if (url.origin !== origin || url.username || url.password) return null;
  const match = /^\/manga\/([a-z0-9][a-z0-9_-]{0,511})(?:\/(chapter-[a-z0-9][a-z0-9_-]{0,159}))?\/?$/.exec(url.pathname);
  return match ? {slug: match[1], ...(match[2] ? {chapter: match[2]} : {})} : null;
}
export const catalogKey = (slug: string) => 'mangadna:' + slug;
export const catalogUrl = (slug: string) => `${origin}/manga/${slug}`;
export const chapterKey = (loc: MangaDnaLocation) => `${catalogKey(loc.slug)}:${loc.chapter}`;
export const chapterUrl = (loc: MangaDnaLocation) => `${catalogUrl(loc.slug)}/${loc.chapter}`;
export const definition: SourceDefinition = {
  id: 'mangadna', name: 'MangaDNA', installation,
  sites: [{id: 'mangadna', name: 'MangaDNA', url: origin + '/', icon, primaryLanguages: ['en'],
    search: {requestOrigins: [origin + '/*']}}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720},
  identify(url) {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = mangaDnaLocation(url);
    if (!loc) return {sourceId: this.id, pageKey: 'mangadna:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapter ? chapterKey(loc) : catalogKey(loc.slug),
      kind: loc.chapter ? 'reader' : 'catalog', url: url.href,
      catalog: {key: catalogKey(loc.slug), url: catalogUrl(loc.slug)}};
  },
};
