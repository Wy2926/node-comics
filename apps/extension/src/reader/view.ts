import type {LibraryState} from '../library/types';
import type {Mode} from '../types';
import {resolvePageView,type PageView} from './presentation';

/** Chapters and editions of the same comic share the reader's explicit choice. */
export function readingViewKey(library:LibraryState,copyId:string){
  const workId=library.coverage.find(item=>item.copyId===copyId)?.workId;
  return 'nc-reading-view:'+JSON.stringify(workId?['work',workId]:['copy',copyId]);
}
export function readReadingView(key:string,defaultMode:Mode):PageView{
  try{
    const value=JSON.parse(localStorage.getItem(key)??'null');
    if(value&&(value.mode==='classic'||value.mode==='redraw')&&(value.preference==='original'||value.preference==='translation'))return {mode:value.mode,preference:value.preference};
  }catch{/* Missing or corrupt preferences never opt a comic into translation. */}
  return resolvePageView(undefined,defaultMode);
}
export function saveReadingView(key:string,view:PageView){
  try{localStorage.setItem(key,JSON.stringify(view));}catch{/* The current reader choice still works when storage is unavailable. */}
}
