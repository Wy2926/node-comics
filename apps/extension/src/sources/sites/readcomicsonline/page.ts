import type {DescribeSourceWork} from '../../contracts/page';
import {catalogKey, catalogUrl, comicLocation} from './definition';

export const describeWork: DescribeSourceWork = ({document, location, signal}) => {
  signal.throwIfAborted();
  const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
  if (location.sourceId !== 'readcomicsonline' || location.kind === 'other') return unavailable;
  try {
    const loc = comicLocation(new URL(location.url)), canonical = document.querySelectorAll('link[rel="canonical"]');
    if (!loc || canonical.length !== 1) return unavailable;
    const href = canonical[0].getAttribute('href'), owner = href && comicLocation(new URL(href, location.url));
    if (!owner || owner.slug !== loc.slug || owner.chapter !== loc.chapter || location.catalog?.key !== catalogKey(loc.slug)) return unavailable;
    const headings = loc.chapter ? [...document.querySelectorAll('nav[aria-label="Breadcrumb"] a[href]')].filter(a => {
      const target = comicLocation(new URL(a.getAttribute('href')!, location.url));
      return target?.slug === loc.slug && !target.chapter;
    }) : [...document.querySelectorAll('main h1')];
    const title = headings[0]?.textContent?.replace(/\s+/g, ' ').trim();
    if (headings.length !== 1 || !title || title.length > 2048 || /[\u0000-\u001f\u007f]/u.test(title)) return unavailable;
    return {status: 'ready', value: {title, catalogId: catalogKey(loc.slug), catalogUrl: catalogUrl(loc.slug)}};
  } catch {return unavailable;}
};
