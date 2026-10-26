import {prepareComicPage} from '../src/comics/pages/normalize';
import {sourcePageCache} from '../src/storage/source-pages';

/** Opt-in synthetic-fixture instrumentation; never installed by the extension. */
export function readerLoadingMetrics(blob:Blob){
 const started=performance.now(),reads:{key:string;ms:number}[]=[],decodes:number[]=[];
 let active=0,peak=0,firstShown:number|undefined,lastShown=0,bitmapCalls=0;
 const shown=new Set<string>();
 const read=sourcePageCache.get.bind(sourcePageCache);
 sourcePageCache.get=async key=>{const start=performance.now();const result=await read(key);reads.push({key,ms:performance.now()-start});return result;};
 const decode=HTMLImageElement.prototype.decode;
 HTMLImageElement.prototype.decode=async function(){
  const start=performance.now();active++;peak=Math.max(peak,active);
  try{await decode.call(this);}finally{active--;decodes.push(performance.now()-start);}
 };
 const bitmap=globalThis.createImageBitmap;
 globalThis.createImageBitmap=((...args:Parameters<typeof bitmap>)=>{bitmapCalls++;return bitmap(...args);}) as typeof bitmap;
 const observer=new MutationObserver(()=>{
  for(const image of document.querySelectorAll<HTMLImageElement>('.nc-page-image'))if(!shown.has(image.src)){
   shown.add(image.src);lastShown=performance.now()-started;firstShown??=lastShown;
  }
 });
 observer.observe(document.getElementById('root')!,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
 const longTasks:number[]=[];
 const tasks=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push(entry.duration);});
 tasks.observe({type:'longtask',buffered:false});
 return {
  snapshot:()=>JSON.stringify({firstShownMs:Math.round(firstShown??0),lastShownMs:Math.round(lastShown),readCount:reads.length,distinctReads:new Set(reads.map(item=>item.key)).size,decodeCalls:decodes.length,activeDecodes:active,peakDecodes:peak,bitmapCalls,decodeMs:decodes.map(Math.round),longTasksMs:longTasks.map(Math.round),displayed:document.querySelectorAll('.nc-page-image').length}),
  async prepare(){
   const results=[];
   for(let n=0;n<3;n++){
    const before=bitmapCalls,start=performance.now();
    const result=await prepareComicPage({name:'4000 × 6000 synthetic PNG',blob});
    results.push({ms:Math.round(performance.now()-start),bitmapCalls:bitmapCalls-before,sameBytes:result.blob===blob,width:result.width,height:result.height});
   }
   return JSON.stringify({sourcePreparation:results});
  },
 };
}
