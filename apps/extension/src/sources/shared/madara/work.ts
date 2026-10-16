import type {DescribeSourceWork} from '../../contracts/page';
import type {MadaraSite} from './config';

/** Current-document metadata only; the breadcrumb links the work independently of chapter labels. */
export function createMadaraWork(site: Pick<MadaraSite, 'id' | 'reader' | 'location' | 'catalogKey' | 'catalogUrl'>): DescribeSourceWork {
  return context => {
    context.signal.throwIfAborted();
    const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
    const {document, location} = context;
    if (location.sourceId !== site.id || location.kind === 'other') return unavailable;
    try {
      const current = site.location(new URL(location.url));
      if (!current) return unavailable;
      const catalogId = site.catalogKey(current.slug), catalogUrl = site.catalogUrl(current.slug);
      if (location.catalog?.key !== catalogId || location.catalog.url !== catalogUrl) return unavailable;
      const canonicals = document.querySelectorAll('link[rel="canonical"]');
      if (canonicals.length !== 1) return unavailable;
      const canonicalHref = canonicals[0].getAttribute('href');
      const canonical = canonicalHref && site.location(new URL(canonicalHref, location.url));
      const expectedChapter = site.reader === 'catalog-select' ? undefined : current.chapter;
      if (!canonical || canonical.slug !== current.slug || canonical.chapter !== expectedChapter) return unavailable;

      let title: string | undefined;
      for (const link of document.querySelectorAll('.c-breadcrumb .breadcrumb a[href]')) {
        const href = link.getAttribute('href');
        if (!href) continue;
        const owner = site.location(new URL(href, location.url));
        if (!owner || owner.chapter) continue;
        const label = link.textContent?.replace(/\s+/gu, ' ').trim();
        if (owner.slug !== current.slug || !label || Array.from(label).length > 2000 || /[\u0000-\u001f\u007f]/u.test(label) ||
            title !== undefined && title !== label) return unavailable;
        title = label;
      }
      return title ? {status: 'ready', value: {title, catalogId, catalogUrl}} : unavailable;
    } catch {
      return unavailable;
    }
  };
}
