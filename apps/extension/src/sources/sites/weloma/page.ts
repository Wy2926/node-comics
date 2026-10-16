import type {DescribeSourceWork} from '../../contracts/page';
import {catalogKey, catalogUrl, welomaLocation} from './definition';
import {decodeBase64, responseLocation} from './html';

function titleOf(element: Element) {
  const encoded = element.getAttribute('data-enc');
  const title = (encoded === null ? element.textContent ?? '' : decodeBase64(encoded)).replace(/\s+/g, ' ').trim();
  return title && Array.from(title).length <= 2000 && !/[\u0000-\u001f\u007f]/.test(title) ? title : undefined;
}

/** Only work metadata; image recognition remains the shared generic session. */
export const describeWork: DescribeSourceWork = ({document, location, signal}) => {
  signal.throwIfAborted();
  const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
  try {
    const loc = welomaLocation(new URL(location.url));
    if (!loc || location.sourceId !== 'weloma' || location.kind === 'other') return unavailable;
    let work = loc.work, title: string | undefined;
    if (!loc.chapter) {
      // The current work URL is supplied in this small login-return literal, not in a canonical link.
      // Reuse the existing identity parser without serializing the full document or executing scripts.
      const identity = document.querySelector('#login + script')?.textContent;
      if (!identity || identity.length > 16_384) return unavailable;
      responseLocation('<script>' + identity + '</script>', location.url);
      const headings = document.querySelectorAll('.manga-info h3');
      if (headings.length !== 1) return unavailable;
      title = titleOf(headings[0]);
    } else {
      const breadcrumbs = document.querySelectorAll('ol.breadcrumb');
      if (breadcrumbs.length !== 1) return unavailable;
      const links = [...breadcrumbs[0].querySelectorAll('a[href]')].map(element => ({element,
        loc: welomaLocation(new URL(element.getAttribute('href')!, location.url)),
      }));
      const owners = links.filter(link => link.loc?.work && !link.loc.chapter);
      const current = links.filter(link => link.loc?.chapter);
      if (owners.length !== 1 || current.length !== 1 || current[0].loc!.chapter !== loc.chapter ||
          loc.work && loc.work !== owners[0].loc!.work || current[0].loc!.work && current[0].loc!.work !== owners[0].loc!.work) return unavailable;
      const owner = owners[0];
      work = owner.loc!.work;
      title = titleOf(owner.element.querySelector('[itemprop="name"]') ?? owner.element);
    }
    if (!work || !title) return unavailable;
    return {status: 'ready', value: {title, catalogId: catalogKey(work), catalogUrl: catalogUrl(work)}};
  } catch {return unavailable;}
};
