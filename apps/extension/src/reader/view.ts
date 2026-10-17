
import type {PageView} from './presentation';
import type {Page,Settings} from '../types';

export type ReadingView = PageView & {zoom:number;fit:Settings['fit'];layout?:Settings['layout'];direction?:Settings['direction']};

export function readingViewDefaults():ReadingView{return {mode:'classic',preference:'original',zoom:100,fit:'window'};}
/** Desktop sizing is immediate; only compact readers need dimensions to detect long images. */
export function initialReadingView(page?:Pick<Page,'width'|'height'>,compact=false):ReadingView|undefined{
  if(!compact)return {...readingViewDefaults(),fit:'width',zoom:50};
  if(!page||!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<=0||page.height<=0)return;
  return {...readingViewDefaults(),...(page.height>=page.width*3?{fit:'width' as const}:{})};
}

/** Comic choices share one record; absent layout/direction inherit the global defaults. */
export function readingViewKey(comicId:string){return 'nc-comic-view:'+comicId;}
export function readStoredReadingView(key:string):ReadingView|undefined{
  try{
    const raw=localStorage.getItem(key);if(raw===null)return;
    const value=JSON.parse(raw);
    const zoom=typeof value?.zoom==='number'&&Number.isFinite(value.zoom)&&value.zoom>=40&&value.zoom<=200&&value.zoom%10===0?value.zoom:100;
    const fit:Settings['fit']=value?.fit==='width'?'width':'window';
    const layout:Settings['layout']|undefined=value?.layout==='continuous'||value?.layout==='single'||value?.layout==='double'?value.layout:undefined;
    const direction:Settings['direction']|undefined=value?.direction==='ltr'||value?.direction==='rtl'?value.direction:undefined;
    const preference=value?.mode==='classic'&&value.preference==='translation'?'translation':'original';
    return {mode:'classic',preference,zoom,fit,...(layout?{layout}:{}),...(direction?{direction}:{})};
  }catch{/* Missing or corrupt preferences never opt a comic into translation. */}
  return readingViewDefaults();
}
export function readReadingView(key:string):ReadingView{return readStoredReadingView(key)??readingViewDefaults();}
export function saveReadingView(key:string,view:ReadingView){
  try{localStorage.setItem(key,JSON.stringify(view));}catch{/* The current reader choice still works when storage is unavailable. */}
}
