import {retainReaderImageURL} from './image-urls';

/** Visual-only outgoing layer: no React callbacks, reading evidence, or source requests. */
export function pageSnapshot(viewport:HTMLDivElement,surface:HTMLDivElement,offset:number){
 const bounds=viewport.getBoundingClientRect(),rect=surface.getBoundingClientRect();
 const host=document.createElement('div'),layer=document.createElement('div'),pixels=surface.cloneNode(true) as HTMLDivElement;
 host.className='nc-page-transition-clip';
 layer.className='nc-page-transition';layer.setAttribute('data-swipe-snapshot','');layer.setAttribute('aria-hidden','true');layer.inert=true;
 Object.assign(host.style,{width:`${viewport.clientWidth}px`,height:`${viewport.clientHeight}px`});
 // Keep the old geometry, including the native vertical pan, independent of the incoming spread.
 Object.assign(pixels.style,{position:'absolute',left:`${rect.left-bounds.left-viewport.clientLeft-offset}px`,top:`${rect.top-bounds.top-viewport.clientTop}px`,
  width:`${surface.offsetWidth}px`,height:`${surface.offsetHeight}px`,minWidth:'0',minHeight:'0',boxSizing:'border-box',transform:'none',willChange:'auto'});
 pixels.className='nc-reading-snapshot';
 // No duplicated document identities or reader selectors; keep only presentation classes.
 for(const element of [pixels,...pixels.querySelectorAll<HTMLElement>('*')]){
  element.removeAttribute('id');
  for(const name of element.getAttributeNames())if(name.startsWith('data-')&&name!=='data-direction'&&name!=='data-paged')element.removeAttribute(name);
 }
 for(const element of pixels.querySelectorAll('.nc-page-image-pending'))element.remove();
 const images=[...pixels.querySelectorAll<HTMLImageElement>('img')];
 const releases=images.map(image=>retainReaderImageURL(image.src));
 layer.append(pixels);host.append(layer);viewport.append(host);
 let disposed=false;
 const position=()=>{host.style.left=`${viewport.scrollLeft}px`;host.style.top=`${viewport.scrollTop}px`;};
 position();viewport.addEventListener('scroll',position,{passive:true});
 return {
  element:layer,
  position,
  dispose(){if(disposed)return;disposed=true;viewport.removeEventListener('scroll',position);host.remove();for(const image of images)image.removeAttribute('src');for(const release of releases)release();},
 };
}
