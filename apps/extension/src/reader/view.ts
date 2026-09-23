
import type {Mode} from '../types';
import {resolvePageView,type PageView} from './presentation';

/** The explicit display choice belongs to this comic only. */
export function readingViewKey(comicId:string){return 'nc-comic-view:'+comicId;}
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
