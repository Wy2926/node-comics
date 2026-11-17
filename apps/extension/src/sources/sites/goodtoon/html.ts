import {madaraHtml} from '../../shared/madara/html';
import {madaraImageUrl} from '../../shared/madara/image';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, definition, isOrigin, mangaLocation, origin, type MangaLocation} from './definition';

export function goodtoonHtml(base = origin) {
  if (!isOrigin(new URL(base))) throw Error('GoodToon 来源地址无效。');
  const site = {id: definition.id, name: definition.name, origin: base, direction: 'ltr' as const,
    location: mangaLocation, catalogKey, catalogUrl: (slug: string) => catalogUrl(slug, base), chapterKey,
    chapterUrl: (loc: MangaLocation) => chapterUrl(loc, base),
    imageUrl: (value: unknown) => madaraImageUrl(base, value)};
  return {site, ...madaraHtml(site), artwork(value: unknown, slug: string) {
    const url = new URL(site.imageUrl(value));
    if (!new RegExp(`^/(?:r2img/)?${slug}/cover(?:_[0-9]+)?\\.(?:jpe?g|png|webp)$`, 'i').test(url.pathname))
      throw Error('GoodToon 封面作品归属错误。');
    return {url: url.href};
  }};
}
/** HTTP follows redirects; the canonical must still name the requested work/chapter. */
export function documentHtml(safe: string, url: string) {
  const helpers = goodtoonHtml(new URL(url).origin);
  const canonical = helpers.canonical(safe, helpers.location(url));
  return goodtoonHtml(new URL(canonical, url).origin);
}
