import {catalog} from '../repositories';
import {bookmarkKey,type BookmarkLocation,type ReaderBookmark} from '../domain/bookmarks';
import {epubLocation} from '../formats/epub-location';
import {randomId} from '../../random-id';
import {msg} from '../../i18n/runtime';
import {pageReference,pageRenderProfile} from '../pages/identity';
export {bookmarkLocation,bookmarkKey,applyBookmark} from '../domain/bookmarks';
export type {BookmarkLocation,ReaderBookmark} from '../domain/bookmarks';

export const BOOKMARK_BATCH=50;
export const countBookmarks=(comicId:string)=>catalog.count('bookmarks',{index:'comicId',range:comicId});
export const findBookmark=async(location:BookmarkLocation)=>(await catalog.list('bookmarks',{index:'locationKey',range:bookmarkKey(location),limit:1}))[0];
export function listBookmarks(comicId:string,before?:ReaderBookmark){
  return catalog.list('bookmarks',{index:'comicCreated',direction:'prev',limit:BOOKMARK_BATCH,
    range:IDBKeyRange.bound([comicId,0,''],before?[comicId,before.createdAt,before.id]:[comicId,Number.MAX_SAFE_INTEGER,'\uffff'],false,!!before)});
}
export const subscribeBookmarks=(listener:()=>void)=>catalog.subscribe(change=>{if(change.table==='bookmarks')listener();});
/** Resolve only a visible bookmark's exact page; never load a chapter or use its old ordinal. */
export async function bookmarkImageKey(location:BookmarkLocation,signal?:AbortSignal):Promise<string|undefined>{
  signal?.throwIfAborted();
  if(location.documentLocation)return;
  const [entry,page]=await Promise.all([catalog.get('entries',location.entryId),catalog.get('pageDescriptors',[location.contentId,location.pageId])]);
  signal?.throwIfAborted();
  if(!entry||entry.comicId!==location.comicId||entry.contentId!==location.contentId||entry.format==='epub'||!page)return;
  return pageReference({entryId:entry.id,contentId:entry.contentId,pageId:page.pageId,renderProfileId:pageRenderProfile(entry.format)});
}
export async function addBookmark(location:BookmarkLocation,restore?:ReaderBookmark):Promise<ReaderBookmark>{
  return catalog.mutate(['bookmarks','entries','comics','pageDescriptors'],async tx=>{
    const entry=await tx.get('entries',location.entryId),comic=await tx.get('comics',location.comicId);
    if(!comic||!entry||entry.comicId!==location.comicId||entry.contentId!==location.contentId||
      (location.documentLocation ? !entry.document||!epubLocation(entry.document,location.documentLocation)
        : !await tx.get('pageDescriptors',[location.contentId,location.pageId])))throw Error(msg('书签位置已不可用，请重新打开内容。'));
    const locationKey=bookmarkKey(location),existing=(await tx.list('bookmarks',{index:'locationKey',range:locationKey,limit:1}))[0];
    if(existing)return existing;
    const value:ReaderBookmark={...location,id:randomId(),locationKey,createdAt:restore?.createdAt??Date.now(),note:restore?.note??''};
    await tx.put('bookmarks',value);return value;
  });
}
export async function deleteBookmark(id:string):Promise<ReaderBookmark|undefined>{
  return catalog.mutate(['bookmarks'],async tx=>{const previous=await tx.get('bookmarks',id);if(previous)await tx.remove('bookmarks',id);return previous;});
}
export async function noteBookmark(id:string,note:string){
  await catalog.patch('bookmarks',id,{note:note.trim().slice(0,200)});
}
