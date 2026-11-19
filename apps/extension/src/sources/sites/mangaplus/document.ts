import type {SourceDocumentProjection} from '../../contracts/network';

interface Chapter {titleId:number; chapterId:number; name:string; subTitle:string; chapterType:number}
interface Detail {
  title: {titleId:number; name:string; language:number};
  chaptersDescending:boolean;
  chapterContentList: {chapter?:Chapter; middleChapters?:{middleChapterList:Chapter[]}}[];
}
interface MangaPage {imageUrl:string; width:number; height:number; encryptionKey:string}
interface Viewer {
  chapterId:number; titleId:number; chapterName:string; isVerticalOnly:boolean; vwToken:string;
  pages: {mangaPage?:MangaPage; lastPage?:object; bannerList?:object; insertBannerList?:object; advertisement?:object}[];
}
type VueElement = Element & {__vue__?:{model?:Viewer; $store?:{state:{detail:{model:Record<string, Detail>}}}}};

// Serialized into the site's main world. Project only the active work; never serialize Vue state.
export const projectCatalog: SourceDocumentProjection = async ({pageUrl, documentToken}) => {
  if (location.href !== pageUrl || Reflect.get(document, Symbol.for('nc-source-page-document')) !== documentToken) return null;
  const id = location.pathname.split('/')[2];
  const m = document.querySelector<VueElement>('#app')?.__vue__?.$store?.state.detail.model[id];
  if (!m?.title?.titleId) return null;
  const rows = [];
  if (!Array.isArray(m.chapterContentList) || m.chapterContentList.length > 10000) throw Error('INVALID_CHAPTER_LIST');
  for (const item of m.chapterContentList) {
    const chapters = item.chapter ? [item.chapter] : item.middleChapters?.middleChapterList;
    if (!Array.isArray(chapters) || rows.length + chapters.length > 10000) throw Error('INVALID_CHAPTER_LIST');
    for (const c of chapters) rows.push({work:c.titleId, id:c.chapterId, name:c.name, subtitle:c.subTitle,
      readable:!!item.chapter && c.chapterType === 0});
  }
  if (m.chaptersDescending) rows.reverse();
  return JSON.stringify({id:m.title.titleId, name:m.title.name, language:m.title.language, rows});
};

export const projectViewer: SourceDocumentProjection = async ({pageUrl, documentToken}) => {
  if (location.href !== pageUrl || Reflect.get(document, Symbol.for('nc-source-page-document')) !== documentToken) return null;
  let el = document.querySelector<VueElement>('.zao');
  while (el && !el.__vue__?.model?.chapterId) el = el.parentElement as VueElement | null;
  const m = el?.__vue__?.model;
  if (!m) return null;
  if (!Array.isArray(m.pages) || m.pages.length > 2000) throw Error('INVALID_VIEWER');
  const pages = [];
  for (const row of m.pages) {
    if (row.mangaPage) {
      const {imageUrl, width, height, encryptionKey} = row.mangaPage;
      pages.push({url:imageUrl, width, height, key:encryptionKey});
    } else if (!row.lastPage && !row.bannerList && !row.insertBannerList && !row.advertisement) throw Error('INVALID_VIEWER');
  }
  return JSON.stringify({id:m.chapterId, work:m.titleId, name:m.chapterName, vertical:m.isVerticalOnly, token:m.vwToken, pages});
};
