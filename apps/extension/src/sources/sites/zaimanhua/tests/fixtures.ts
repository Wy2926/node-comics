export const original = 'https://www.zaimanhua.com/info/fixture.html';
export const manga = 'https://manhua.zaimanhua.com/details/42';
export const reader = 'https://www.zaimanhua.com/view/fixture/42/11';
export const mangaReader = 'https://manhua.zaimanhua.com/view/fixture/42/11';
export const imageUrl = 'https://images.example/page-1.jpg?sign=fixture';
export const envelope = (value: unknown) => JSON.stringify({errno: 0, errmsg: '', data: value});
export const chapter = (chapter_id: number, chapter_order: number, is_fee = false) => ({chapter_id, chapter_order, chapter_title: '第' + chapter_id + '话', is_fee});
export function comic() {
  return {id: 42, title: '再漫画测试作品', comicPy: 'fixture', canRead: true, isFee: false,
    cover: 'https://images.example/cover.jpg', lastUpdateChapterId: 7,
    chapterList: [{title: '连载', data: [chapter(7, 30), chapter(50, 20, true), chapter(11, 0)]},
      {title: '番外', data: [chapter(90, 2), chapter(80, 1)]}]};
}
export const catalogBody = () => envelope({comicInfo: comic()});
export const pageInfo = () => ({chapter_id: 11, comic_id: 42, title: '第11话', chapter_order: 0,
  direction: 2, picnum: 0, page_url: [imageUrl, imageUrl, 'https://other.example/page-3.png']});
export const pagesBody = () => envelope({chapterInfo: pageInfo()});
