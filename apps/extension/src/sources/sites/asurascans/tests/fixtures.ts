// Synthetic data matching the site's SSR tuple format; no source text or artwork is stored.
export const origin = 'https://asurascans.com';
export const work = 'fixture-work', publicSlug = work + '-1234abcd';
export const url = origin + '/comics/' + publicSlug, readerUrl = url + '/chapter/1';
export const cover = 'https://cdn.asurascans.com/asura-images/covers/fixture.webp';
export const image = 'https://cdn.asurascans.com/asura-images/chapters/fixture/1/a.webp?v=1';
export const encode = (value: unknown): unknown[] => Array.isArray(value) ? [1, value.map(encode)] :
  [0, value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) : value];
export const propsJson = (props: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(props).map(([key, value]) => [key, encode(value)])));
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const island = (name: string, props: Record<string, unknown>) => `<astro-island component-url="/_astro/${name}.Fixture-1.js" props="${escape(propsJson(props))}"></astro-island>`;
export const identity = (target: string) => `<link rel="canonical" href="${target}">`;
export const chapter = (number: number, id = number * 10) => ({id, series_id: 99, series_slug: work, number, page_count: 2, is_premium: false});
export const detail = () => ({seriesId: 99, chapterCount: 3, title: 'Fixture & Book', type: 'manhwa'});
export const directory = () => ({chapters: [chapter(3), {...chapter(1.5), title: 'Extra'}, chapter(1)], seriesSlug: work,
  totalChapters: 3, coverUrl: cover, publicUrl: '/comics/' + publicSlug});
export const reader = () => ({seriesId: 99, seriesSlug: publicSlug, seriesName: 'Fixture & Book', chapterId: 10,
  chapterNumber: 1, isLocked: false, pages: [{url: image, width: 900, height: 16000}, {url: image, width: 900, height: 16000}]});
export const catalogHtml = (list: Record<string, unknown> = directory(), meta: Record<string, unknown> = detail(), target = url) =>
  identity(target) + island('DescriptionModal', meta) + island('ChapterListReact', list);
export const readerHtml = (props: Record<string, unknown> = reader(), target?: string) =>
  (target ? identity(target) : '') + island('ChapterReader', props) + '<img src="https://ads.invalid/banner.png">';
export const hit = (index: number) => ({id: index + 1, slug: work + '-' + index, public_url: '/comics/' + work + '-' + index + '-1234abcd',
  title: 'Fixture ' + index, type: 'manhwa', cover, author: 'Example', chapter_count: 3});
export const results = (page = 1, total = 21, query = 'sample') => ({initialQuery: query, fixedContentMode: 'comics',
  initialSeries: Array.from({length: Math.min(20, Math.max(0, total - (page - 1) * 20))}, (_, i) => hit((page - 1) * 20 + i)),
  totalCount: total, initialTotalPages: Math.ceil(total / 20), initialCurrentPage: page});
export const searchHtml = (props: Record<string, unknown> = results()) => island('BrowseFilters', props);
