
import type {PageView} from './presentation';
import type {Page,Settings} from '../types';

export type ReadingView = PageView & {zoom:number;fit:Settings['fit']};

export function readingViewDefaults():ReadingView{return {mode:'classic',preference:'original',zoom:100,fit:'window'};}
/** Only known image dimensions can establish a comic's initial sizing. */
export function initialReadingView(page?:Pick<Page,'width'|'height'>):ReadingView|undefined{
  if(!page||!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<=0||page.height<=0)return;
  return {...readingViewDefaults(),...(page.height>=page.width*3?{fit:'width' as const,zoom:50}:{})};
}

/** Display choice, image fit and proportional zoom belong to this comic only. */
export function readingViewKey(comicId:string){return 'nc-comic-view:'+comicId;}
export function readStoredReadingView(key:string):ReadingView|undefined{
  try{
    const raw=localStorage.getItem(key);if(raw===null)return;
    const value=JSON.parse(raw);
    const zoom=typeof value?.zoom==='number'&&Number.isFinite(value.zoom)&&value.zoom>=40&&value.zoom<=200&&value.zoom%10===0?value.zoom:100;
    const fit:Settings['fit']=value?.fit==='width'?'width':'window';
    if(value&&value.mode==='classic'&&(value.preference==='original'||value.preference==='translation'))return {mode:value.mode,preference:value.preference,zoom,fit};
    return {mode:'classic',preference:'original',zoom,fit};
  }catch{/* Missing or corrupt preferences never opt a comic into translation. */}
  return readingViewDefaults();
}
export function readReadingView(key:string):ReadingView{return readStoredReadingView(key)??readingViewDefaults();}
export function saveReadingView(key:string,view:ReadingView){
  try{localStorage.setItem(key,JSON.stringify(view));}catch{/* The current reader choice still works when storage is unavailable. */}
}
