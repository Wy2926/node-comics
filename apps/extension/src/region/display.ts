import {msg} from '../i18n/runtime';

export interface RegionBox {x:number;y:number;width:number;height:number;}
type ImagePlacement={kind:'image';element:HTMLImageElement;source:string;naturalWidth:number;naturalHeight:number;box:RegionBox;offset:RegionBox;};
export type RegionPlacement=ImagePlacement|{kind:'viewport';box:RegionBox}|{kind:'preview';box:RegionBox};
const box=(rect:DOMRect):RegionBox=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
const inside=(inner:RegionBox,outer:RegionBox)=>inner.x>=outer.x-.25&&inner.y>=outer.y-.25&&inner.x+inner.width<=outer.x+outer.width+.25&&inner.y+inner.height<=outer.y+outer.height+.25;
const intersects=(a:RegionBox,b:RegionBox)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const plain=(value:string,empty:string)=>!value||value===empty;
function unchangedTransform(node:Element,value:string){
  if(plain(value,'none'))return true;
  // Even an identity transform on the root changes the fixed overlay's
  // containing block. Identity transforms below it do not move image pixels.
  if(node===document.documentElement)return false;
  try{return new DOMMatrixReadOnly(value).isIdentity;}catch{return false;}
}
function untransformed(element:Element){
  for(let node:Element|null=element;node;node=node.parentElement){
    const css=getComputedStyle(node);
    // CSS content can replace an img's visible pixels without changing src or
    // its box. Such images cannot identify the frozen screenshot's content.
    if(node instanceof HTMLImageElement&&!plain(css.content,'normal')&&css.content!=='none')return false;
    if(!unchangedTransform(node,css.transform)||!plain(css.translate,'none')||!plain(css.rotate,'none')||!plain(css.scale,'none')||
      !plain(css.filter,'none')||!plain(css.backdropFilter,'none')||!plain(css.clipPath,'none')||!plain(css.maskImage,'none')||!plain(css.mixBlendMode,'normal')||!plain(css.perspective,'none')||Number(css.opacity||1)!==1||
      node.getAnimations?.().some(animation=>animation.playState==='running'))return false;
  }
  return true;
}
function imageReady(image:HTMLImageElement){
  const css=getComputedStyle(image);
  return image.isConnected&&image.complete&&image.naturalWidth>0&&image.naturalHeight>0&&
    css.visibility!=='hidden'&&css.display!=='none'&&plain(css.objectFit,'fill')&&
    ['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].every(name=>!parseFloat(css[name as keyof CSSStyleDeclaration] as string))&&
    !/\.(?:gif|apng)(?:$|[?#])|^data:image\/(?:gif|apng);/i.test(image.currentSrc||image.src)&&untransformed(image);
}
const points=(rect:RegionBox)=>[.08,.5,.92].flatMap(x=>[.08,.5,.92].map(y=>({x:rect.x+rect.width*x,y:rect.y+rect.height*y})));
function topElement(point:{x:number;y:number},host:HTMLElement){
  return document.elementsFromPoint(point.x,point.y).find(element=>element!==host&&!host.contains(element));
}

/** Capture pixels and display placement are separate. Unknown/dynamic surfaces never gain an image anchor. */
export function capturePlacement(rect:RegionBox,host:HTMLElement):RegionPlacement{
  const targets=points(rect).map(point=>topElement(point,host)),first=targets[0];
  if(first instanceof HTMLImageElement&&targets.every(target=>target===first)&&imageReady(first)){
    const bounds=box(first.getBoundingClientRect());
    if(inside(rect,bounds))return {kind:'image',element:first,source:first.currentSrc||first.src,naturalWidth:first.naturalWidth,naturalHeight:first.naturalHeight,box:bounds,offset:{x:rect.x-bounds.x,y:rect.y-bounds.y,width:rect.width,height:rect.height}};
  }
  // A top-frame observer cannot see pixels changing inside these surfaces.
  const dynamic=[...document.querySelectorAll('iframe,canvas,video,object,embed')].some(element=>intersects(rect,box(element.getBoundingClientRect())))||
    targets.some(element=>element&&(element.localName.includes('-')||!!element.shadowRoot||!untransformed(element)));
  return {kind:dynamic?'preview':'viewport',box:{...rect}};
}

/** Follow position changes without stretching the frozen crop after a resize. */
export function projectImageRegion(placement:{box:RegionBox;offset:RegionBox},current:RegionBox):RegionBox|undefined{
  if(Math.abs(current.width-placement.box.width)>.5||Math.abs(current.height-placement.box.height)>.5)return;
  return {x:current.x+placement.offset.x,y:current.y+placement.offset.y,width:placement.offset.width,height:placement.offset.height};
}
/** Content/geometry changes invalidate a crop; temporary occlusion does not. */
export function imagePlacementValid(placement:ImagePlacement):boolean{
  const image=placement.element;
  return imageReady(image)&&(image.currentSrc||image.src)===placement.source&&image.naturalWidth===placement.naturalWidth&&image.naturalHeight===placement.naturalHeight&&
    !!projectImageRegion(placement,box(image.getBoundingClientRect()));
}
export function placementBox(placement:RegionPlacement,host:HTMLElement):RegionBox|undefined{
  if(placement.kind==='preview')return;
  if(placement.kind==='viewport')return placement.box;
  const image=placement.element;
  if(!imagePlacementValid(placement))return;
  const rect=projectImageRegion(placement,box(image.getBoundingClientRect()));if(!rect)return;
  // Do not paint above an ancestor's scroll clipping, or over another visible page control.
  for(let parent=image.parentElement;parent;parent=parent.parentElement){
    const css=getComputedStyle(parent);
    if(/hidden|clip|scroll|auto/.test(css.overflow+css.overflowX+css.overflowY)&&!inside(rect,box(parent.getBoundingClientRect())))return;
  }
  const visible={x:Math.max(0,rect.x),y:Math.max(0,rect.y),width:Math.min(innerWidth,rect.x+rect.width)-Math.max(0,rect.x),height:Math.min(innerHeight,rect.y+rect.height)-Math.max(0,rect.y)};
  if(visible.width<=0||visible.height<=0)return;
  if(points(visible).some(point=>topElement(point,host)!==image))return;
  return rect;
}

/** A pointer-transparent crop, never a replacement for the site's full image or DOM node. */
export class RegionDisplay{
  private image?:HTMLImageElement;
  private objectUrl?:string;
  private pending?:{image:HTMLImageElement;url:string};
  private loading?:HTMLDivElement;
  key?:string;
  constructor(private readonly surface:HTMLElement){}
  private cancelPending(){
    const pending=this.pending;this.pending=undefined;
    if(pending){pending.image.removeAttribute('src');URL.revokeObjectURL(pending.url);}
  }
  async show(blob:Blob,key:string,current:()=>boolean){
    this.cancelPending();
    const url=URL.createObjectURL(blob),image=new Image(),pending={image,url};this.pending=pending;image.src=url;
    try{await image.decode();}catch{
      if(this.pending!==pending)return;
      this.cancelPending();if(!current())return;
      throw Error(msg('当前网站阻止显示译图，原图已保留。'));
    }
    // A cleared or superseded decode owns neither the new image nor its object URL.
    if(this.pending!==pending)return;
    this.pending=undefined;
    if(!current()){image.removeAttribute('src');URL.revokeObjectURL(url);return;}
    this.clear();this.image=image;this.objectUrl=url;this.key=key;
    image.alt='';image.setAttribute('aria-hidden','true');image.dataset.ncRegionTranslation='';
    image.style.cssText='all:initial;display:none;position:fixed;max-width:none;max-height:none;object-fit:fill;pointer-events:none;user-select:none';
    this.surface.prepend(image);
  }
  paint(rect:RegionBox|undefined,visible=true){
    if(!this.image)return;
    this.image.style.display=visible&&rect?'block':'none';
    if(rect)Object.assign(this.image.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
  }
  paintLoading(rect:RegionBox|undefined,visible=true){
    if(!this.loading&&rect&&visible){
      this.loading=document.createElement('div');this.loading.className='loading-frame';this.loading.dataset.ncRegionLoading='';this.loading.setAttribute('aria-hidden','true');
      const label=document.createElement('span');this.loading.append(label);this.surface.prepend(this.loading);
    }
    const frame=this.loading;if(!frame)return;
    frame.style.display=visible&&rect?'block':'none';frame.style.pointerEvents='none';
    if(rect)Object.assign(frame.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
    frame.firstElementChild!.textContent=msg('翻译中…');
  }
  clear(){this.cancelPending();this.loading?.remove();this.loading=undefined;this.image?.remove();this.image?.removeAttribute('src');this.image=undefined;if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=undefined;this.key=undefined;}
}
