import type {Discovery} from '../../contracts/page';
import type {SourceWorkReference} from '../../contracts/work';
import {sourceCover} from '../../shared/cover';
import {mangaCopyLocation} from './definition';

export function describeWork(document: Document, url: string): Discovery<SourceWorkReference> {
  const location = mangaCopyLocation(url);
  // Reader h4 mixes the work and chapter with '/', which is also valid in work names.
  if (!location || location.chapterId) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
  const headings = [...document.querySelectorAll('.comicParticulars-title-right h6')];
  const title = headings.length === 1 ? headings[0].textContent?.trim() : undefined;
  if (!title || title.length > 2048) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
  const image = document.querySelector('.comicParticulars-title-left img');
  return {status: 'ready', value: {title, catalogId: 'mangacopy:' + location.slug, catalogUrl: new URL('/comic/' + location.slug, url).href,
    cover: sourceCover(image?.getAttribute('data-src') ?? image?.getAttribute('src'), url)}};
}
