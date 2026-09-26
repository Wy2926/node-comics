import type {Discovery} from '../../contracts/page';
import type {SourceWorkReference} from '../../contracts/work';
import {sourceCover} from '../../shared/cover';
import {catalogUrl, dm5Location} from './definition';
import {assignment, text} from './parsing';

export function describeWork(document: Document, url: string): Discovery<SourceWorkReference> {
  const location = dm5Location(new URL(url));
  // The reader exposes only DM5_CTITLE (work + chapter); never strip a chapter suffix.
  if (!location?.slug || location.chapterId) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
  try {
    const scripts = [...document.querySelectorAll('script:not([src])')].map(node => node.textContent ?? '').join('\n');
    const canonical = new URL(text(assignment(scripts, 'DM5_COMIC_URL')), url), owner = dm5Location(canonical);
    if (owner?.slug !== location.slug || owner.chapterId) return {status: 'error', code: 'SOURCE_WORK_INVALID'};
    return {status: 'ready', value: {title: text(assignment(scripts, 'DM5_COMIC_MNAME')), catalogId: 'dm5:' + location.slug,
      catalogUrl: catalogUrl(location.slug), cover: sourceCover(document.querySelector('.banner_detail_form .cover img')?.getAttribute('src'), url)}};
  } catch {return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};}
}
