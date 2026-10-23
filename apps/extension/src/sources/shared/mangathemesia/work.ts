import type {DescribeSourceWork} from '../../contracts/page';
import type {MangaThemesiaSite} from './config';

type WorkSite = Pick<MangaThemesiaSite, 'id' | 'location' | 'catalogKey' | 'catalogUrl'>;

/** Current-document metadata only: no chapter-list parsing, requests or image recognition. */
export function mangaThemesiaWork(site: WorkSite): DescribeSourceWork {
  return context => {
    context.signal.throwIfAborted();
    const unavailable = {status: 'not-ready', code: 'SOURCE_WORK_UNAVAILABLE'} as const;
    if (context.location.sourceId !== site.id) return unavailable;
    try {
      const current = site.location(new URL(context.location.url)), doc = context.document;
      if (!current) return unavailable;
      const canonicals = doc.querySelectorAll('link[rel="canonical"]');
      const hrefs = [...canonicals].map(element => element.getAttribute('href'));
      if (!hrefs.length || !hrefs[0] || hrefs.some(href => href !== hrefs[0])) return unavailable;
      const href = hrefs[0];
      const canonical = site.location(new URL(href, context.location.url));
      if (!canonical || canonical.chapterSlug !== current.chapterSlug ||
        !current.chapterSlug && canonical.catalogSlug !== current.catalogSlug) return unavailable;

      let catalogSlug = current.catalogSlug, title: string | undefined;
      if (current.chapterSlug) {
        // The chapter heading and document/OG titles contain the chapter name.
        // The theme's dedicated owner link supplies the work name, even when the slugs differ.
        const owners = doc.querySelectorAll('.chapterbody .allc a[href]');
        if (owners.length !== 1) return unavailable;
        const ownerHref = owners[0].getAttribute('href');
        const owner = ownerHref ? site.location(new URL(ownerHref, context.location.url)) : null;
        if (!owner?.catalogSlug || owner.chapterSlug ||
          catalogSlug && catalogSlug !== owner.catalogSlug ||
          canonical.catalogSlug && canonical.catalogSlug !== owner.catalogSlug) return unavailable;
        catalogSlug = owner.catalogSlug;
        title = owners[0].textContent ?? undefined;
      } else {
        const headings = doc.querySelectorAll('.postbody h1.entry-title');
        if (headings.length !== 1) return unavailable;
        title = headings[0].textContent ?? undefined;
      }
      title = title?.replace(/\s+/gu, ' ').trim();
      if (!catalogSlug || !title || Array.from(title).length > 2000 || /[\u0000-\u001f\u007f]/u.test(title)) return unavailable;
      return {status: 'ready', value: {title, catalogId: site.catalogKey(catalogSlug), catalogUrl: site.catalogUrl(catalogSlug)}};
    } catch {return unavailable;}
  };
}
