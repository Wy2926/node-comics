import type {Discovery} from '../../contracts/page';
import type {SourceWorkReference} from '../../contracts/work';
import {sourceCover} from '../../shared/cover';
import {catalogUrl, guaziLocation} from './definition';
import {object, text} from './html';

export function describeWork(document: Document, url: string): Discovery<SourceWorkReference> {
  const location = guaziLocation(new URL(url));
  if (!location) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
  try {
    const rows = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(node => {
      const data = object(JSON.parse(node.textContent ?? ''));
      return Array.isArray(data['@graph']) ? data['@graph'].map(object) : [data];
    });
    const matches = rows.filter(row => row['@type'] === (location.chapterId ? 'Article' : 'ComicStory'));
    if (matches.length !== 1) return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};
    const row = matches[0], observed = guaziLocation(new URL(text(row.url)));
    if (!observed || observed.chapterId !== location.chapterId || !location.chapterId && observed.comicId !== location.comicId)
      return {status: 'error', code: 'SOURCE_WORK_INVALID'};
    const work = location.chapterId ? object(row.isPartOf) : row, owner = guaziLocation(new URL(text(work.url)));
    if (work['@type'] !== 'ComicStory' || !owner?.comicId || owner.chapterId || location.comicId && owner.comicId !== location.comicId)
      return {status: 'error', code: 'SOURCE_WORK_INVALID'};
    return {status: 'ready', value: {title: text(work.name), catalogId: 'guazimanhua:' + owner.comicId,
      catalogUrl: catalogUrl(owner.comicId), cover: sourceCover(work.image, url)}};
  } catch {return {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'};}
}
