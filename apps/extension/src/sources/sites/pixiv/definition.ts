import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const origin = 'https://www.pixiv.net';
export type PixivCategory = 'artworks' | 'illustrations' | 'manga';
export interface PixivCollection {userId: string; category?: PixivCategory; tag?: string; seriesId?: string}
const isCategory = (value: unknown): value is PixivCategory => value === 'artworks' || value === 'illustrations' || value === 'manga';
const id = /^[1-9]\d{0,19}$/;
export const isId = (value: unknown): value is string => typeof value === 'string' && id.test(value);
const validTag = (value: string) => value.length > 0 && value.length <= 180 && !/[\u0000-\u001f\u007f]/.test(value);
export const catalogUrl = ({userId, category = 'artworks', tag, seriesId}: PixivCollection) => seriesId
  ? `${origin}/user/${userId}/series/${seriesId}` : `${origin}/users/${userId}/${category}${tag === undefined ? '' : '/' + encodeURIComponent(tag)}`;
// Preserve existing whole-author/tag identities when the home page is imported.
export const catalogKey = ({userId, category = 'artworks', tag, seriesId}: PixivCollection) => `pixiv:user:${userId}:${seriesId
  ? 'series:' + seriesId : (category === 'artworks' ? '' : category + ':') + (tag === undefined ? 'all' : 'tag:' + encodeURIComponent(tag))}`;
export const entryKey = (collection: PixivCollection, artworkId: string) => `${catalogKey(collection)}:artwork:${artworkId}`;
export function artworkUrl(collection: PixivCollection, artworkId: string) {
  const binding = new URLSearchParams({'nodelane-pixiv': collection.userId});
  if (collection.seriesId) binding.set('series', collection.seriesId);
  if (collection.category && collection.category !== 'artworks') binding.set('category', collection.category);
  if (collection.tag !== undefined) binding.set('tag', collection.tag);
  return `${origin}/artworks/${artworkId}#${binding}`;
}
export function pixivLocation(url: URL): (PixivCollection & {artworkId?: string}) | null {
  if (url.origin !== origin || url.username || url.password) return null;
  const series = /^\/(?:en\/)?user\/([1-9]\d{0,19})\/series\/([1-9]\d{0,19})\/?$/.exec(url.pathname);
  if (series) return {userId: series[1], seriesId: series[2]};
  const catalog = /^\/(?:en\/)?users\/([1-9]\d{0,19})(?:\/(artworks|illustrations|manga)(?:\/([^/]+))?)?\/?$/.exec(url.pathname);
  if (catalog) {
    let tag: string | undefined;
    try {tag = catalog[3] === undefined ? undefined : decodeURIComponent(catalog[3]);} catch {return null;}
    // Filtering belongs in the path; never silently turn a query filter into the whole author.
    if (tag !== undefined && !validTag(tag) || url.searchParams.has('tag')) return null;
    return {userId: catalog[1], category: catalog[2] as PixivCategory | undefined, tag};
  }
  const artwork = /^\/(?:en\/)?artworks\/([1-9]\d{0,19})\/?$/.exec(url.pathname);
  if (!artwork || !url.hash.startsWith('#nodelane-pixiv=')) return null;
  const binding = new URLSearchParams(url.hash.slice(1)), userId = binding.get('nodelane-pixiv'), tag = binding.get('tag') ?? undefined;
  const category = binding.get('category') ?? undefined;
  const seriesId = binding.get('series') ?? undefined;
  if (!isId(userId) || binding.getAll('nodelane-pixiv').length !== 1 || binding.getAll('tag').length > 1 || binding.getAll('category').length > 1 ||
    binding.getAll('series').length > 1 || seriesId !== undefined && (!isId(seriesId) || category !== undefined || tag !== undefined) ||
    category !== undefined && !isCategory(category) || [...binding.keys()].some(key => !['nodelane-pixiv', 'tag', 'category', 'series'].includes(key)) ||
    tag !== undefined && !validTag(tag)) return null;
  return {userId, category, tag, seriesId, artworkId: artwork[1]};
}
export const definition: SourceDefinition = {
  id: 'pixiv', name: 'pixiv', installation,
  sites: [{id: 'pixiv', name: 'pixiv', url: origin + '/', icon, adaptedOn: '2026-09-29', contentTags: ['manga', 'doujin'], primaryLanguages: ['ja', 'zh-Hans', 'en']}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true, findAlternatives: false},
  embeddedEntry: 'floating',
  inlineRecognition: 'generic', catalogSync: {intervalMinutes: 720},
  identify(url) {
    const loc = pixivLocation(url);
    // Native artwork pages stay with generic recognition; only catalog-bound reader URLs belong here.
    if (!loc) return null;
    return {sourceId: this.id, pageKey: loc.artworkId ? entryKey(loc, loc.artworkId) : catalogKey(loc),
      kind: loc.artworkId ? 'reader' : 'catalog', url: url.href, catalog: {key: catalogKey(loc), url: catalogUrl(loc)}};
  },
};
