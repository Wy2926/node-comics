import type {EpubLocation} from '../formats/contracts';
import type {ReadingEntry} from '../../types';
import {epubLocation} from '../formats/epub-location';

/** Source anchors only: no image bytes, source URLs or presentation settings. */
export interface BookmarkLocation {
  comicId: string;
  entryId: string;
  contentId: string;
  title: string;
  pageId: string;
  pageNumber: number;
  relativeOffset: number;
  documentLocation?: EpubLocation;
}
export interface ReaderBookmark extends BookmarkLocation {
  id: string;
  locationKey: string;
  createdAt: number;
  note: string;
}
export function bookmarkLocation(copy: ReadingEntry, pageId=copy.pageId, relativeOffset=copy.relativeOffset,pageNumber?:number): BookmarkLocation | undefined {
  if(!copy.comicId || !copy.contentId)return;
  const documentLocation=copy.document ? epubLocation(copy.document,copy.documentLocation) : undefined;
  const index=documentLocation?-1:pageNumber!==undefined&&copy.pages[pageNumber-1]?.id===pageId?pageNumber-1:copy.pages.findIndex(page=>page.id===pageId);
  if(copy.document ? !documentLocation : index<0)return;
  return {comicId:copy.comicId,entryId:copy.id,contentId:copy.contentId,title:copy.title,
    pageId:documentLocation?'':pageId,pageNumber:documentLocation?0:index+1,
    relativeOffset:Number.isFinite(relativeOffset)?Math.max(0,Math.min(1,relativeOffset)):0,
    ...(documentLocation?{documentLocation}:{})};
}
/** One bookmark per image page; EPUB uses the exact text anchor and scroll fraction. */
export function bookmarkKey(location: BookmarkLocation): string {
  const doc=location.documentLocation;
  return JSON.stringify([location.comicId,location.entryId,location.contentId,
    doc ? ['epub',doc.cfi??doc.href,Math.round((doc.progression??0)*1000)] : ['page',location.pageId]]);
}
/** Never fall back to the first page when the source has changed. */
export function applyBookmark(copy: ReadingEntry, location: BookmarkLocation): ReadingEntry | undefined {
  if(copy.comicId!==location.comicId || copy.id!==location.entryId || copy.contentId!==location.contentId)return;
  if(location.documentLocation){
    const documentLocation=copy.document&&epubLocation(copy.document,location.documentLocation);
    return documentLocation?{...copy,documentLocation}:undefined;
  }
  if(copy.document || !copy.pages.some(page=>page.id===location.pageId))return;
  return {...copy,pageId:location.pageId,relativeOffset:Math.max(0,Math.min(1,location.relativeOffset))};
}
