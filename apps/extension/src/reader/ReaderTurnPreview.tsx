import {useMemo,type RefObject} from 'react';
import type {Mode,ReadingEntry,Settings} from '../types';
import {BlobPicture} from './Images';
import {pageFrame} from './geometry';
import {pageSpreads,spreadAt,spreadFrames} from './pagination';
import {readingImage} from './presentation';
import {msg} from '../i18n/runtime';

const noAction=()=>{};
/** One inert destination group. It shares the image loader, never reading evidence or translation work. */
export function ReaderTurnPreview({ref,chapter,index,ready,viewport,layout,direction,compare,mode,translated,language,translationScope,scope,fit,zoom,top}: {
 ref:RefObject<HTMLDivElement|null>;chapter?:ReadingEntry;index:number|'last';ready:boolean;viewport:{width:number;height:number};
 layout:Settings['layout'];direction:Settings['direction'];compare:boolean;mode:Mode;translated:boolean;language:string;translationScope?:string;
 scope:(page:ReadingEntry['pages'][number],chapter:ReadingEntry)=>string;fit:Settings['fit'];zoom:number;top:number;
}){
 const at=index==='last'?Math.max(0,(chapter?.pages.length??0)-1):index;
 const spreads=useMemo(()=>layout==='double'&&chapter?pageSpreads(chapter.pages):[],[layout,chapter?.pages]);
 const spread=spreadAt(spreads,at);
 const pages=ready&&chapter?chapter.pages.slice(spread?spread.start:at,spread?spread.end:at+1):[];
 const frames=layout==='double'?spreadFrames(pages,viewport,compare):pages.map(page=>pageFrame(page,viewport,fit,zoom,compare));
 return <div ref={ref} className="nc-reading-turn-preview" aria-hidden="true" inert style={{width:viewport.width,height:viewport.height,top}}>
  <div className="nc-page-stack" data-direction={direction}>{pages.map((page,n)=>{
   const identity=scope(page,chapter!),image=readingImage(page,mode,translated,language,translationScope),frame=frames[n];
   return <div className="nc-manga-page" key={page.id} style={{width:frame.width}}><div className={`nc-page-picture ${compare?'comparison':''}`} style={{height:frame.height}}>
    {compare&&<div className="nc-comparison-pane"><BlobPicture shareForTurn priority="prefetch" scope={`${identity}:compare`} blobKey={page.blobKey} alt="" error={page.fetchError} onImport={noAction}/></div>}
    <div className="nc-comparison-pane"><BlobPicture shareForTurn priority="prefetch" scope={identity} originalKey={page.blobKey} blobKey={image.key} job={image.job} alt="" error={page.fetchError} onImport={noAction}/></div>
   </div></div>;
  })}</div>
  {!pages.length&&<div className="nc-image-placeholder"><span className="spinner"/>{msg('正在准备页面…')}</div>}
 </div>;
}
