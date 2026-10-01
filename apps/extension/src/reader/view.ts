
import type {Mode} from '../types';
import {resolvePageView,type PageView} from './presentation';

export type ReadingView = PageView & {zoom:number};

/** Display choice and proportional zoom belong to this comic only. */
export function readingViewKey(comicId:string){return 'nc-comic-view:'+comicId;}
export function readReadingView(key:string,defaultMode:Mode):ReadingView{
  try{
    const value=JSON.parse(localStorage.getItem(key)??'null');
    const zoom=typeof value?.zoom==='number'&&Number.isFinite(value.zoom)&&value.zoom>=40&&value.zoom<=200&&value.zoom%10===0?value.zoom:100;
    if(value&&(value.mode==='classic'||value.mode==='redraw')&&(value.preference==='original'||value.preference==='translation'))return {mode:value.mode,preference:value.preference,zoom};
    return {...resolvePageView(undefined,defaultMode),zoom};
  }catch{/* Missing or corrupt preferences never opt a comic into translation. */}
  return {...resolvePageView(undefined,defaultMode),zoom:100};
}
export function saveReadingView(key:string,view:ReadingView){
  try{localStorage.setItem(key,JSON.stringify(view));}catch{/* The current reader choice still works when storage is unavailable. */}
}
