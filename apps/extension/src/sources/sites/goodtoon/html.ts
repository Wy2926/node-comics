import {madaraHtml} from '../../shared/madara/html';
import {madaraImageUrl} from '../../shared/madara/image';
import {catalogKey, catalogUrl, chapterKey, chapterUrl, definition, mangaLocation, origin} from './definition';

export const site = {id: definition.id, name: definition.name, origin, direction: 'ltr' as const,
  location: mangaLocation, catalogKey, catalogUrl, chapterKey, chapterUrl,
  imageUrl: (value: unknown) => madaraImageUrl(origin, value)};
export const {one, text, location, regions, byClass, canonical} = madaraHtml(site);

export function artwork(value: unknown, slug: string) {
  const url = new URL(site.imageUrl(value));
  if (!new RegExp(`^/(?:r2img/)?${slug}/cover(?:_[0-9]+)?\\.(?:jpe?g|png|webp)$`, 'i').test(url.pathname))
    throw Error('GoodToon 封面作品归属错误。');
  return {url: url.href};
}
