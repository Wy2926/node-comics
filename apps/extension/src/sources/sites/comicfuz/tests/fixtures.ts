import {encode} from '../../../shared/protobuf';
export const workUrl = 'https://comic-fuz.com/manga/2062', readerUrl = workUrl + '?chapterId=47170';
export const recipe = 'comicfuz-aes:' + '11'.repeat(32) + ':' + '22'.repeat(16);
interface Chapter {chapterId: number; chapterMainName: string; chapterSubName?: string; pointConsumption: {type?: number; amount?: number}}
export const catalog = () => ({page: '/manga/[mangaId]', query: {mangaId: '2062'}, props: {pageProps: {
  manga: {mangaId: 2062, mangaName: 'Fixture Manga', mainThumbnailUrl: '/c/version/art.webp?h=fixture&e=5000000000'},
  chapters: [
    {bookIssueHeader: {bookIssueId: '200', text: '第2巻'}, chapters: [
      {chapterId: 47176, chapterMainName: '第3話', pointConsumption: {type: 2, amount: 60}},
      {chapterId: 47173, chapterMainName: '第2話', pointConsumption: {amount: 30}},
    ]},
    {bookIssueHeader: {bookIssueId: '100', text: '第1巻'}, chapters: [
      {chapterId: 47170, chapterMainName: '第0話', chapterSubName: '導入', pointConsumption: {}},
    ]},
  ] as Array<{bookIssueHeader: {bookIssueId: string; text: string}; chapters: Chapter[]}>, viewButton: {chapter: {chapterId: 47170}},
}}});
export const html = (data: unknown = catalog()) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
export const imagePage = (order = 0, overrides: Array<[number, number | string | Uint8Array]> = []) => {
  const fields = new Map<number, number | string | Uint8Array>([
    [1, `/f/version/bx2/${order}.jpeg.enc?h=fixture&e=5000000000&ct=2`], [3, '22'.repeat(16)], [4, '11'.repeat(32)], [5, 1354], [6, 1920],
    ...overrides,
  ]);
  return encode([1, encode(...fields)]);
};
export function viewer(pages = [imagePage(0), imagePage(1)], overrides: Array<[number, number | string | Uint8Array]> = []) {
  return encode(...new Map<number, number | string | Uint8Array>([
    [2, encode([1, '第0話'], ...pages.map(page => [2, page] as [number, Uint8Array]))],
    [5, encode([2, encode([1, 47170], [2, '第0話'])])], [11, encode([1, 2062], [2, 'Fixture Manga'])], [12, 47170], ...overrides,
  ]));
}
