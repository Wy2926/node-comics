// Reduced public protocol shapes. IDs, titles, UUIDs and image signatures are synthetic.
export const seriesId = '1000000001', secondId = '1000000002', thirdId = '1000000003';
export const cellId = '00000000-0000-4000-8000-000000000001';
export const row = (bookId: string, title = '테스트 1화') => ({bookId, title, badges: ['FREE']});
export const list = (books = [row(seriesId)], nextPage: object | null = {order: 'SEQUENTIAL', offset: 1, limit: 100}) => ({
  books, seriesId, currentOrder: 'SEQUENTIAL', currentTabType: 'RENT', pagination: {nextPage, prevPage: null},
});
export const readerData = (bookId = seriesId) => ({detail: {book: {
  b_id: bookId, series_id: seriesId, title: '테스트 1화', series_title: '테스트', binding_type: 'left',
  content_type: {is_comic: true, is_webtoon: true},
}}});
export const catalogData = () => ({props: {pageProps: {sectionProps: {
  bookId: seriesId, gridQuery: {riGrid: {grid: {cells: [
    {type: 'BookDetailHomeHeader', cell__BookDetailHomeHeader: {information: {
      bookId: seriesId, title: {title: '테스트'}, series: {id: seriesId, openedBookCount: 3, openedTrialBookCount: 0},
    }}},
    {type: 'BookDetailHomeMetadata', cell__BookDetailHomeMetadata: {
      fileInfo: {formats: ['WEBTOON']}, supportEnvironment: {webViewer: true},
    }},
    {id: cellId, type: 'BookDetailHomeEpisodeBookList', cell__BookDetailHomeEpisodeBookList: list()},
  ]}}},
}}}});
export const html = (id: string, data: object) => `<script id="${id}" type="application/json">${JSON.stringify(data)}</script>`;
export const graphql = (value = list([row(secondId, '테스트 2화'), row(thirdId, '테스트 3화')], null)) => ({
  data: {riGrid: {cells: {bookDetailHome: {episodeBookListCell: {cell: value}}}}},
});
export const pagesData = () => ({success: true, data: {type: 'comic', pages: [0, 1].map(index => ({
  filename: `__ridi__${index}.webp`, src: `https://webview-cache.ridibooks.com/${seriesId}/webtoon/__ridi__${index}.webp?Signature=fixture`,
  width: 720, height: index ? 120 : 1280,
}))}});
