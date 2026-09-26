import type {Discovery} from '../../contracts/page';
import type {SourceWorkReference} from '../../contracts/work';
import {catalogUrl, mangaDexLocation} from './definition';

export function describeWork(document: Document, url: string): Discovery<SourceWorkReference> {
  const location = mangaDexLocation(new URL(url));
  if (!location?.mangaId || location.chapterId) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
  const urls = [...document.querySelectorAll('meta[property="og:url"]')], titles = [...document.querySelectorAll('meta[property="og:title"]')];
  if (urls.length !== 1 || titles.length !== 1) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
  try {
    const owner = mangaDexLocation(new URL(urls[0].getAttribute('content') ?? ''));
    if (owner?.mangaId !== location.mangaId || owner.chapterId) return {status: 'error', code: 'SOURCE_WORK_INVALID'};
    // This is the verified work OpenGraph label, not document.title or a chapter heading.
    const label = titles[0].getAttribute('content'), title = label?.endsWith(' - MangaDex') ? label.slice(0, -11).trim() : undefined;
    if (!title || title.length > 2048) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
    return {status: 'ready', value: {title, catalogId: 'mangadex:' + location.mangaId, catalogUrl: catalogUrl(location.mangaId)}};
  } catch {return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};}
}
