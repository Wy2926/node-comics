// Sanitized structural fixtures based on MangaPill's server markup. No image bytes or comic text.
export const work = '42', chapter = '10001000';
export const title = 'Fixture & Work', chapterTitle = title + ' Chapter 1';
export const bareUrl = 'https://mangapill.com/manga/42';
export const url = bareUrl + '/fixture-work';
export const reader = 'https://mangapill.com/chapters/42-10001000/fixture-work-chapter-1';
export const boundReader = reader + '#nodelane-mangapill=fixture-work';
export const image = 'https://cdn.readdetectiveconan.com/file/mangap/42/10001000/1.jpeg?t=1668064755';
export const modernImage = 'https://cdn.readdetectiveconan.com/file/mangap/2026/39/42/10001000/019fc801-868c-75a6-a7e1-fa02ca554bdc/1.jpeg';
export const cover = 'https://cdn.readdetectiveconan.com/file/mangapill/i/42.webp?h=01971742-5d7f-7f32-8d2b-d038279f8a73';
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
export interface FixtureChapter {id: string; title: string; slug?: string}
export const chapterRows = (): FixtureChapter[] => [
  {id: '10003000', title: 'Chapter 3', slug: 'fixture-work-chapter-3'},
  {id: '10001500', title: 'Chapter 1.5', slug: 'fixture-work-chapter-1-5'},
  {id: chapter, title: 'Chapter 1', slug: 'fixture-work-chapter-1'},
];
export function catalogHtml(rows = chapterRows()) {
  return `<html><head><meta property="og:image" content="${cover}"></head><body>
    <div class="flex"><div><img data-src="${cover}" alt="${escape(title)}" class="lazy"></div>
    <div><h1 class="font-bold text-lg md:text-2xl">${escape(title)}</h1></div></div>
    <div id="chapters" class="p-3"><div data-filter-list class="my-3 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6">
    ${rows.map(row => `<a class="border border-border p-1 hover:bg-brand hover:text-white" href="/chapters/42-${row.id}/${row.slug ?? 'fixture-' + row.id}" title=" ${escape(row.title)}">${escape(row.title)}</a>`).join('\n')}
    </div></div></body></html>`;
}
export function pageHtml(number: number, total = 3, src = image) {
  return `<chapter-page><div class="primary"><div data-summary class="border-b border-border">
    <svg data-reload><path d="M0 0"/></svg><div class="text-xs">page ${number}/${total}</div><span></span></div>
    <div class="relative bg-card"><picture><img class="js-page" data-src="${src}" alt="${escape(chapterTitle)} Page ${number}" loading="lazy" width="1066" height="1600"/></picture></div>
    </div></chapter-page>`;
}
export function readerHtml(numbers = [1, 2, 3], src = image, total = 3) {
  return `<html><body>
    <h1 id="top" class="text-xl">${escape(chapterTitle)}</h1>
    <div class="lg:container">${numbers.map(number => pageHtml(number, total, src)).join('\n')}</div>
    <div class="modal" id="js-chapter-selector-modal"><div class="modal__overlay"><div class="modal__container">
      <div><div id="chapter-selector-modal-title" class="text-primary font-black">${escape(title)} Chapters</div>
      <a href="/manga/42" class="block text-sm text-brand" data-hotkey="m">Go To Manga</a></div>
      <include-fragment id="js-chapter-selector-fragment" src="/manga/42/chapters?current=${chapter}" loading="lazy"><p>Loading chapters...</p></include-fragment>
    </div></div></div></body></html>`;
}
export function searchHtml(query = 'Fixture', ids = ['42', '43'], page = 1, next = false) {
  const searchLink = (n: number) => `/search?q=${encodeURIComponent(query)}&amp;status=&amp;type=&amp;page=${n}`;
  return `<html><body><form action="/search" class="form"><input id="title" type="text" name="q" value="${escape(query)}"/></form>
    ${!ids.length ? '<div class="text-center text-lg"><div class="font-black">No results found</div></div>' : ''}
    <div class="my-3 grid justify-end gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
    ${ids.map(id => `<div><a href="/manga/${id}/fixture-${id}" class="relative block"><figure>
      <img data-src="https://cdn.readdetectiveconan.com/file/mangapill/i/${id}.jpeg" alt="Fixture ${id} Fixture ${id}" class="lazy"/></figure></a>
      <div class="flex flex-col justify-end"><a href="/manga/${id}/fixture-${id}" class="mb-2"><div class="mt-3 font-black leading-tight line-clamp-2">Fixture ${id}</div>
      <div class="line-clamp-2 text-xs text-secondary mt-1">Alternative ${id}</div></a>
      <div class="flex flex-wrap gap-1 mt-1"><div class="text-xs leading-5 bg-purple-500">manga</div></div></div></div>`).join('\n')}
    </div><div class="flex items-center justify-center my-3 gap-3">
      ${page > 1 ? `<a href="${searchLink(page - 1)}" class="btn btn-sm">Previous</a>` : ''}
      ${next ? `<a href="${searchLink(page + 1)}" class="btn btn-sm">Next</a>` : ''}
    </div></body></html>`;
}
export interface FixtureQuickResult {id: string; slug: string; title?: string; cover?: string}
export function quickHtml(rows: FixtureQuickResult[] = [{id: work, slug: 'fixture-work', title}]) {
  return `<div class="grid gap-3">${rows.map(row => `<a class="grid-cols-1 bg-card rounded p-3" href="/manga/${row.id}/${row.slug}">
    <div class="flex"><div class="flex-none h-20 w-20"><img class="h-full w-full lazy object-cover rounded"
    src="${row.cover ?? 'https://cdn.readdetectiveconan.com/file/mangapill/i/' + row.id + '.jpeg'}" loading="lazy"></div>
    <div class="ml-3"><div class="flex flex-col items-start"><div class="font-black">${escape(row.title ?? 'Fixture ' + row.id)}</div>
    <div class="text-sm text-secondary"></div><div class="flex flex-wrap gap-3 mt-1 text-xs text-secondary"><div>manga</div></div>
    </div></div></div></a>`).join('\n')}</div>`;
}
