import {retainReaderImageURL} from './image-urls';

/** Inert paper faces. They borrow displayed URLs; they never acquire or decode a source. */
export function pageSnapshot(viewport:HTMLDivElement,surface:HTMLDivElement,columns:1|2,frame={left:0,top:0,width:viewport.clientWidth,height:viewport.clientHeight}){
 const bounds=viewport.getBoundingClientRect(),rect=surface.getBoundingClientRect();
 const width=frame.width/columns;
 const images:HTMLImageElement[]=[],canvases:HTMLCanvasElement[]=[],releases:(()=>void)[]=[];
 const originals=[...surface.querySelectorAll<HTMLCanvasElement>('.nc-page-preview')];
 const pageBounds=[...surface.querySelectorAll<HTMLElement>('.nc-manga-page')].map(page=>page.getBoundingClientRect());
 const leaves=Array.from({length:columns},(_,column)=>{
  const leaf=document.createElement('div'),pixels=surface.cloneNode(true) as HTMLDivElement;
  leaf.className='nc-flip-leaf';leaf.setAttribute('aria-hidden','true');leaf.inert=true;
  Object.assign(pixels.style,{position:'absolute',left:`${rect.left-bounds.left-viewport.clientLeft-frame.left-column*width}px`,top:`${rect.top-bounds.top-viewport.clientTop-frame.top}px`,
   width:`${surface.offsetWidth}px`,height:`${surface.offsetHeight}px`,minWidth:'0',minHeight:'0',boxSizing:'border-box',transform:'none',visibility:'visible',willChange:'auto'});
  pixels.className='nc-reading-snapshot';
  const previews=[...pixels.querySelectorAll<HTMLCanvasElement>('.nc-page-preview')];
  // Keep the layout box, but do not retain images from the other half of a spread.
  [...pixels.querySelectorAll<HTMLElement>('.nc-manga-page')].forEach((page,index)=>{
   const rect=pageBounds[index],left=bounds.left+frame.left+column*width;
   if(rect&&(rect.right<=left+.5||rect.left>=left+width-.5))page.replaceChildren();
  });
  for(const element of [pixels,...pixels.querySelectorAll<HTMLElement>('*')]){
   element.removeAttribute('id');
   for(const name of element.getAttributeNames())if(name.startsWith('data-')&&name!=='data-direction'&&name!=='data-paged')element.removeAttribute(name);
  }
  for(const pending of pixels.querySelectorAll('.nc-page-image-pending'))pending.remove();
  previews.forEach((canvas,index)=>{
   if(!pixels.contains(canvas))return;
   const original=originals[index];canvases.push(canvas);
   if(original?.style.display!=='none'&&original?.width>1&&original.height>1){
    try{canvas.getContext('2d')?.drawImage(original,0,0);}catch{/* A failed visual copy must not block navigation. */}
   }
  });
  for(const image of pixels.querySelectorAll<HTMLImageElement>('img')){images.push(image);releases.push(retainReaderImageURL(image.src));}
  leaf.append(pixels);return leaf;
 });
 let disposed=false;
 return {leaves,dispose(){
  if(disposed)return;disposed=true;
  for(const image of images)image.removeAttribute('src');
  for(const canvas of canvases)canvas.width=canvas.height=1;
  for(const release of releases)release();
  for(const leaf of leaves)leaf.remove();
 }};
}
