import type {DescribeSourceWork} from '../../contracts/page';
import {catalogKey, catalogUrl, mangaLocation} from './definition';

export const describeWork: DescribeSourceWork = ({document, location, signal}) => {
  signal.throwIfAborted();
  const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
  if (location.sourceId !== 'goodtoon' || location.kind === 'other') return unavailable;
  try {
    const current = mangaLocation(new URL(location.url)), canonical = document.querySelectorAll('link[rel="canonical"]');
    if (!current || canonical.length !== 1) return unavailable;
    const href = canonical[0].getAttribute('href'), owner = href && mangaLocation(new URL(href, location.url));
    if (!owner || owner.slug !== current.slug || owner.chapter !== current.chapter ||
        location.catalog?.key !== catalogKey(current.slug) || location.catalog.url !== catalogUrl(current.slug)) return unavailable;
    const headings = document.querySelectorAll('h1.reader-title-manga');
    const title = headings[0]?.textContent?.replace(/\s+/gu, ' ').trim();
    if (headings.length !== 1 || !title || title.length > 2000 || /[\u0000-\u001f\u007f]/u.test(title)) return unavailable;
    const workLinks = [...document.querySelectorAll('a.reader-ctl[href]')].filter(link => {
      const target = mangaLocation(new URL(link.getAttribute('href')!, location.url));
      return target?.slug === current.slug && !target.chapter;
    });
    return workLinks.length === 1 ? {status: 'ready', value: {title, catalogId: catalogKey(current.slug), catalogUrl: catalogUrl(current.slug)}} : unavailable;
  } catch {return unavailable;}
};
