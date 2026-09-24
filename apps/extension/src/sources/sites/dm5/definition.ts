import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://www.dm5.com';
export function dm5Location(url: URL) {
  if (url.protocol !== 'https:' || !['www.dm5.com', 'dm5.com'].includes(url.hostname) || url.port || url.username || url.password) return null;
  const catalog = /^\/manhua-([a-z0-9-]+)\/$/.exec(url.pathname);
  if (catalog) return {slug: catalog[1], chapterId: undefined};
  const chapter = /^\/m([1-9]\d*)(?:-p[1-9]\d*)?\/$/.exec(url.pathname);
  if (!chapter) return null;
  // DM5 chapter paths do not contain their comic. Keep the verified catalog binding
  // locally in a fragment (never sent to DM5), and verify it again against the reader HTML.
  const binding = /^#nodelane-dm5=([a-z0-9-]+)$/.exec(url.hash);
  if (url.hash.startsWith('#nodelane-dm5') && !binding) return null;
  return {slug: binding?.[1], chapterId: chapter[1]};
}
export const catalogUrl = (slug: string) => `${origin}/manhua-${slug}/`;
export const chapterUrl = (id: string) => `${origin}/m${id}/`;
export const definition: SourceDefinition = {
  id: 'dm5', name: '动漫屋 DM5',
  sites: [{id: 'dm5', name: '动漫屋 DM5', url: origin + '/', icon}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  catalogSync: {intervalMinutes: 720}, installation,
  identify(url) {
    if (url.protocol !== 'https:' || !['www.dm5.com', 'dm5.com'].includes(url.hostname) || url.port || url.username || url.password) return null;
    const loc = dm5Location(url);
    if (!loc) return {sourceId: this.id, pageKey: 'dm5:' + url.href, kind: 'other', url: url.href};
    return {sourceId: this.id, pageKey: loc.chapterId ? 'dm5:chapter:' + loc.chapterId : 'dm5:' + loc.slug,
      kind: loc.chapterId ? 'reader' : 'catalog', url: url.href,
      ...(loc.slug ? {catalog: {key: 'dm5:' + loc.slug, url: catalogUrl(loc.slug)}} : {})};
  },
};
