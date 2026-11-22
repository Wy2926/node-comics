import type {Rect,TextRegion} from '../../../../../third_party/shinobu/packages/image-pipeline/src/types';
import {Sha256} from '../../../../importers/hash';

export function pageBands(width:number,height:number):Rect[]{
  const vertical=height>=width,short=Math.min(width,height),long=Math.max(width,height);
  if(long<=2048||long<3*short)return [{x:0,y:0,width,height}];
  // The 1024² detector needs readable glyphs and context on both sides of a cut.
  const count=Math.ceil(long/Math.min(1536,Math.max(768,short*1.5))),halo=Math.floor(long/count/5);
  return Array.from({length:count},(_,i)=>{
    const start=Math.max(0,Math.floor(i*long/count)-halo),end=Math.min(long,Math.floor((i+1)*long/count)+halo);
    return vertical?{x:0,y:start,width,height:end-start}:{x:start,y:0,width:end-start,height};
  });
}

export interface DetectedBand {rect:Rect;regions:TextRegion[];mask?:Blob;}
const pageBox=({x,y}:Rect,{box}:TextRegion)=>({...box,x:x+box.x,y:y+box.y});
function sameLine(a:Rect,b:Rect){
  const overlap=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  return overlap>=0.72*Math.min(a.width*a.height,b.width*b.height);
}

/** Keep unmatched detections even when only the neighbouring crop saw the line. */
export function reconcileOverlap(left:DetectedBand,right:DetectedBand){
  const vertical=left.rect.y!==right.rect.y,axis=vertical?'y':'x',size=vertical?'height':'width';
  const start=right.rect[axis],end=left.rect[axis]+left.rect[size];
  const candidates=left.regions.map(region=>({region,box:pageBox(left.rect,region)})).filter(({box})=>box[axis]+box[size]>start);
  const incoming=right.regions.map(region=>({region,box:pageBox(right.rect,region)})).filter(({box})=>box[axis]<end);
  // Prefer one side for a whole dialogue: place the ownership boundary in the widest text-free gap.
  let edge=start,cut=(start+end)/2,gap=0;
  for(const {box} of [...candidates,...incoming].sort((a,b)=>a.box[axis]-b.box[axis])){
    const next=Math.min(end,box[axis]);
    if(next-edge>gap){gap=next-edge;cut=(edge+next)/2;}
    edge=Math.max(edge,box[axis]+box[size]);
  }
  if(end-edge>gap)cut=(edge+end)/2;
  const discarded=new Set<TextRegion>();
  for(const {region,box} of incoming){
    const match=candidates.find(candidate=>!discarded.has(candidate.region)&&sameLine(box,candidate.box));
    if(!match)continue;
    const keepLeft=box[axis]<=start+2||match.box[axis]+match.box[size]<end-2&&match.box[axis]+match.box[size]/2<cut;
    discarded.add(keepLeft?region:match.region);
  }
  left.regions=left.regions.filter(region=>!discarded.has(region));
  right.regions=right.regions.filter(region=>!discarded.has(region));
}

export function textId(rect:Rect,region:TextRegion,index:number){
  // Checkpoints depend on page geometry and OCR, never random detector IDs or per-pixel bubble masks.
  const {x,y,width,height}=pageBox(rect,region);
  return 'r'+index+'_'+new Sha256().update(new TextEncoder().encode(JSON.stringify([x,y,width,height,region.sourceText]))).digest().slice(0,32);
}
