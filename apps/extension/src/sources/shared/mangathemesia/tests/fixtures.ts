import type {SourceDefinition} from '../../../contracts/definition';
import type {MangaThemesiaLocation, MangaThemesiaSite} from '../config';

/** Original, synthetic markup; no source pages, images or credentials are retained. */
export function fixtureSite(id = 'alpha', directory = 'manga', direction: 'ltr' | 'rtl' = 'rtl') {
  const origin = `https://${id}.mangathemesia.test`, imageOrigin = `https://images-${id}.mangathemesia.test`;
  const binding = `#nodelane-${id}=`;
  const catalogKey = (slug: string) => `${id}:manga:${slug}`;
  const chapterKey = (slug: string) => `${id}:chapter:${slug}`;
  const catalogUrl = (slug: string) => `${origin}/${directory}/${slug}/`;
  const chapterUrl = (slug: string, catalogSlug?: string) => `${origin}/${slug}/${catalogSlug ? binding + catalogSlug : ''}`;
  return {
    id, name: `Fixture ${id}`, origin, direction, imageOrigin, catalogKey, chapterKey, catalogUrl, chapterUrl, emptySearchText: 'Not Found',
    location(url: URL): MangaThemesiaLocation | null {
      if (url.origin !== origin || url.username || url.password || url.search) return null;
      const catalog = new RegExp(`^/${directory}/([a-z0-9-]+)/?$`).exec(url.pathname);
      if (catalog) return url.hash ? null : {catalogSlug: catalog[1]};
      const chapter = /^\/([a-z0-9-]+-chapter-[a-z0-9.-]+)\/?$/.exec(url.pathname);
      if (!chapter) return null;
      const owner = url.hash.startsWith(binding) ? url.hash.slice(binding.length) : undefined;
      if (url.hash && (!owner || !/^[a-z0-9-]+$/.test(owner))) return null;
      return {chapterSlug: chapter[1], ...(owner ? {catalogSlug: owner} : {})};
    },
    searchUrl(query: string, page: number) {
      return origin + (page === 1 ? '/' : `/page/${page}/`) + '?' + new URLSearchParams({s: query});
    },
    imageUrl(value: unknown) {
      if (typeof value !== 'string' || !value.trim()) throw Error('fixture image missing');
      const url = new URL(value.trim(), origin);
      if (url.origin !== imageOrigin || url.username || url.password || url.hash) throw Error('fixture image policy');
      return url.href;
    },
  } satisfies MangaThemesiaSite & {imageOrigin: string};
}

export const sites = [fixtureSite(), fixtureSite('beta', 'comics', 'ltr')];
export type FixtureSite = ReturnType<typeof fixtureSite>;
export const work = 'sample', chapter = 'sample-chapter-1';
export const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const canonical = (url: string) => `<link rel="canonical" href="${escape(url)}">`;
export const envelope = (body: string, head = '') => `<html><head>${head}</head><body>${body}</body></html>`;
export const coverUrl = (site: FixtureSite) => site.imageOrigin + '/cover.jpg';
export const pageUrl = (site: FixtureSite, index = 0) => `${site.imageOrigin}/pages/${index}.jpg`;

type WorkElement = {textContent: string; getAttribute(name: string): string | null};
export const workElement = (textContent: string, href = ''): WorkElement => ({textContent, getAttribute: name => name === 'href' ? href : null});
export function workDocument(canonical: string, title = 'Sample & Book', owner?: string) {
  const nodes: Record<string, WorkElement[]> = {
    'link[rel="canonical"]': [workElement('', canonical)],
    '.postbody h1.entry-title': owner ? [] : [workElement(title)],
    '.chapterbody .allc a[href]': owner ? [workElement(title, owner)] : [],
  };
  const document = {title: 'Chapter 99 - Never use this title', querySelectorAll: (selector: string) => nodes[selector] ?? []} as unknown as Document;
  return {nodes, document};
}

export function fixtureDefinition(site: FixtureSite): SourceDefinition {
  return {
    id: site.id, name: site.name, installation: {autoContentMatches: [], optionalContentMatches: [site.origin + '/*']},
    capabilities: {importable: true, catalog: true, pages: true, inline: true, completePageList: true},
    inlineRecognition: 'generic',
    identify(url) {
      const loc = site.location(url);
      if (!loc) return null;
      return {sourceId: site.id, pageKey: loc.chapterSlug ? site.chapterKey(loc.chapterSlug) : site.catalogKey(loc.catalogSlug!),
        kind: loc.chapterSlug ? 'reader' : 'catalog', url: url.href,
        ...(loc.catalogSlug ? {catalog: {key: site.catalogKey(loc.catalogSlug), url: site.catalogUrl(loc.catalogSlug)}} : {})};
    },
  };
}

export const chapterRow = (site: FixtureSite, slug: string, label = slug) => `<li data-num="1"><div class="chbox"><div class="eph-num"><a href="${site.chapterUrl(slug)}"><span class="chapternum">${escape(label)}</span><span class="chapterdate">January 1, 2026</span></a></div></div></li>`;
export function catalogHtml(site: FixtureSite, chapters = ['sample-chapter-2.5', chapter]) {
  return envelope(`<div class="postbody"><div class="bigcontent"><div class="thumb"><img src="${coverUrl(site)}" itemprop="image"></div><div class="infox"><h1 class="entry-title">Sample &amp; Book</h1></div></div><div class="bixbox bxcl epcheck"><div class="releases"><h2>Chapters</h2></div><div id="chapterlist" class="eplister"><ul>${chapters.map(slug => chapterRow(site, slug)).join('')}</ul></div></div></div>`, canonical(site.catalogUrl(work)));
}

export function readerData(site: FixtureSite, images = [pageUrl(site), pageUrl(site)]) {
  return {post_id: 42, protected: false, is_novel: false, unlock_token: null, mode: 'full', contentmode: 'advanced',
    defaultSource: 'Server 1', sources: [{source: 'Server 1', images}]};
}
export function readerHtml(site: FixtureSite, images?: string[]) {
  return envelope(`<div class="chapterbody"><h1 class="entry-title">Sample Chapter 1</h1><div class="allc"><a href="${site.catalogUrl(work)}">All chapters</a></div><div id="readerarea"></div><script>ts_reader.run(${JSON.stringify(readerData(site, images))});</script></div>`, canonical(site.chapterUrl(chapter)));
}

export function searchCard(site: FixtureSite, slug = 'sample-0') {
  return `<div class="bs"><div class="bsx"><a href="${site.catalogUrl(slug)}" title="Sample &amp; ${slug}"><img src="${coverUrl(site)}"><div class="tt">Sample &amp; ${slug}</div></a></div></div>`;
}
export function searchHtml(site: FixtureSite, count = 2, page = 1, next = false, query = 'a & 日本語') {
  return envelope(`<div class="postbody"><div class="bixbox"><div class="releases"><h1>Search '${escape(query)}'</h1></div><div class="listupd">${Array.from({length: count}, (_, i) => searchCard(site, `sample-${(page - 1) * count + i}`)).join('')}${count ? '' : `<center><h3>${escape(site.emptySearchText)}</h3></center>`}</div>${count ? `<div class="pagination"><span class="page-numbers current" aria-current="page">${page}</span>${next ? `<a class="next page-numbers" href="${escape(site.searchUrl(query, page + 1))}">Next »</a>` : ''}</div>` : ''}</div></div>`);
}
