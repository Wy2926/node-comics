import type {PipelineCanvas,PipelineRenderingContext} from '../../../../../third_party/shinobu/packages/image-pipeline/src/runtime/platform';
import type {BubbleMask,TextRegion} from '../../../../../third_party/shinobu/packages/image-pipeline/src/types';
import {resolveColors} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/color';
import {resolveInitialFontSize,strokeWidth} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/fontMetrics';
import {formatTypesetFont,resolveTypesetFontFamily,supportedTypesetText} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/fontRuntime';
import {resolveHorizontalLineMetrics,resolveHorizontalSafeInterval} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/horizontalFit';
import {segmentVerticalGraphemes as graphemes} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/verticalOrientation';

function letteringBox(region:TextRegion,mask?:BubbleMask){
  if(mask){
    const cx=region.box.x+region.box.width/2-mask.x,cy=region.box.y+region.box.height/2-mask.y;
    // An inscribed band near the dialogue avoids the balloon's tail and rounded corners.
    for(const ratio of [0.68,0.45]){
      const height=Math.max(1,Math.floor(mask.height*ratio)),top=Math.max(0,Math.min(mask.height-height,Math.round(cy-height/2)));
      const span=resolveHorizontalSafeInterval({region:{...region,box:mask,quad:undefined},mask,contentWidth:mask.width,
        localTopY:top,localBottomY:top+height,preferredContentX:cx,safetyMargin:0});
      if(span.source==='mask'&&span.left<=cx&&cx<=span.right)return {x:mask.x+span.left,y:mask.y+top,width:span.width,height};
    }
  }
  return region.box;
}

function* breakablePieces(word:string){
  let piece='';
  for(const segment of graphemes(word)){
    if(piece&&!/[¿¡«“(\[]$/u.test(piece)&&!/^[!?.,;:…»”)\]]/u.test(segment)){yield piece;piece='';}
    piece+=segment;
  }
  if(piece)yield piece;
}

function centeredWidth(ctx:PipelineRenderingContext,text:string){
  const m=ctx.measureText(text);
  return Math.max(m.width,2*(m.actualBoundingBoxLeft??0),2*(m.actualBoundingBoxRight??0));
}

function wrap(ctx:PipelineRenderingContext,words:string[],width:number,rows:number,breakLongWords:boolean){
  const fits=(text:string)=>centeredWidth(ctx,text)<=width;
  const lines:string[]=[];
  let line='';
  for(const word of words){
    if(line){
      const next=line+' '+word;
      if(fits(next)){line=next;continue;}
      lines.push(line);if(lines.length>=rows)return;
    }
    if(fits(word)){line=word;continue;}
    if(!breakLongWords)return;
    line='';
    for(const piece of breakablePieces(word)){
      if(fits(line+piece)){line+=piece;continue;}
      if(!line||!fits(piece))return;
      lines.push(line);if(lines.length>=rows)return;
      line=piece;
    }
  }
  return [...lines,line];
}

function drawDialogue(ctx:PipelineRenderingContext,region:TextRegion,mask:BubbleMask|undefined,canvas:PipelineCanvas){
  const text=supportedTypesetText(region.translatedText.normalize('NFC')).trim().replace(/([¿¡])\s+/gu,'$1').replace(/\s+([!?,.;:…])/gu,'$1');
  if(!text)return;
  const box=letteringBox(region,mask),x=Math.max(0,box.x),y=Math.max(0,box.y);
  const w=Math.min(canvas.width,box.x+box.width)-x,h=Math.min(canvas.height,box.y+box.height)-y;
  if(w<=0||h<=0)return;
  const words=text.split(/\s+/u),family=resolveTypesetFontFamily(),maxSize=Math.max(1,Math.floor(Math.min(h,resolveInitialFontSize(region))));
  function layout(size:number,breakWords:boolean){
    ctx.font=formatTypesetFont(size,family);
    const sw=strokeWidth(size),pad=Math.min(w,h)*0.04+sw,width=w-2*pad;
    const {inkAscent,inkDescent}=resolveHorizontalLineMetrics(ctx,text,size);
    const ink=inkAscent+inkDescent,pitch=Math.max(1.15*size,ink+2*sw);
    const rows=1+Math.floor((h-2*pad-ink)/pitch);
    if(rows<1||width<=0)return;
    const lines=wrap(ctx,words,width,rows,breakWords);
    if(lines)return {size,width,lines,pitch,inkAscent,inkDescent};
  }
  function fit(min:number,breakWords:boolean){
    let best=layout(maxSize,breakWords);
    if(best)return best;
    let lo=min,hi=maxSize-1;
    while(lo<=hi){
      const size=Math.floor((lo+hi)/2),candidate=layout(size,breakWords);
      if(candidate){best=candidate;lo=size+1;}else hi=size-1;
    }
    return best;
  }
  // Fragment an overlong word only if keeping it intact would make the dialogue substantially smaller.
  const whole=fit(1,false),minSplit=whole?Math.ceil(whole.size*1.4):1;
  const fitted=minSplit<=maxSize?fit(minSplit,true)??whole:whole;
  const size=fitted?.size??1;
  ctx.font=formatTypesetFont(size,family);
  let lines=fitted?.lines??[words.join(' ')];
  // Canvas has no CSS text-wrap: balance. Find the narrowest measure that keeps the same line count.
  if(fitted&&fitted===whole&&lines.length>1&&lines.length<=6){
    let lo=0,hi=fitted.width;
    while(hi-lo>1){
      const mid=(lo+hi)/2,balanced=wrap(ctx,words,mid,lines.length,false);
      if(balanced){lines=balanced;hi=mid;}else lo=mid;
    }
  }
  const colors=resolveColors(region.fgColor,region.bgColor);
  ctx.lineWidth=2*strokeWidth(size);ctx.strokeStyle=colors.bg;ctx.fillStyle=colors.fg;
  const {inkAscent,inkDescent}=fitted??resolveHorizontalLineMetrics(ctx,lines[0],size);
  const pitch=fitted?.pitch??0;
  ctx.save();ctx.translate(x+w/2,y+h/2);
  if(!fitted){
    // A sub-glyph OCR box must not fail the other regions or paint over its neighbour.
    const scale=Math.min(1,w/(centeredWidth(ctx,lines[0])+2),h/(inkAscent+inkDescent+2));ctx.scale(scale,scale);
  }
  const first=(inkAscent-inkDescent-(lines.length-1)*pitch)/2;
  for(const [i,line] of lines.entries()){
    ctx.strokeText(line,0,first+i*pitch);ctx.fillText(line,0,first+i*pitch);
  }
  ctx.restore();
}

export function drawLatinTypeset(canvas:PipelineCanvas,regions:TextRegion[]){
  const ctx=canvas.getContext('2d')!;
  ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.lineJoin='round';
  const counts=new Map<BubbleMask,number>();
  for(const {bubbleMask} of regions)if(bubbleMask)counts.set(bubbleMask,(counts.get(bubbleMask)??0)+1);
  for(const region of regions){
    const mask=region.bubbleMask;
    drawDialogue(ctx,region,mask&&counts.get(mask)===1?mask:undefined,canvas);
  }
}
