import type {DescribeSourceWork} from '../../contracts/page';
import {batcaveLocation, catalogKey, catalogUrl} from './definition';
import {text} from './html';

export const describeWork: DescribeSourceWork = ({document, location, signal}) => {
  signal.throwIfAborted();
  const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
  if (location.sourceId !== 'batcave' || location.kind === 'other') return unavailable;
  try {
    const loc = batcaveLocation(new URL(location.url)), link = document.querySelectorAll('link[rel="canonical"]')[0];
    if (!loc) return unavailable;
    const actual = link ? batcaveLocation(new URL(text(link.getAttribute('href')), location.url)) : loc;
    if (!actual || actual.work !== loc.work || actual.chapter !== loc.chapter) return unavailable;
    const heading = document.querySelectorAll(loc.chapter ? 'a.header__post-link' : 'h1')[0];
    const parent = loc.chapter ? batcaveLocation(new URL(text(heading?.getAttribute('href')), location.url)) : actual;
    if (!parent || parent.chapter || parent.work !== loc.work) return unavailable;
    return {status: 'ready', value: {title: text(heading?.textContent || document.title || `BatCave ${loc.work}`),
      catalogId: catalogKey(loc.work), catalogUrl: catalogUrl(parent)}};
  } catch {return unavailable;}
};
