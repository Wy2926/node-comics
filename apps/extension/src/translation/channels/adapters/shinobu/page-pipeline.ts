import {BitmapPipelineImage} from '../../../../../third_party/shinobu/apps/web/src/runtime/offscreenPlatform';
import type {ModelRuntime} from '../../../../../third_party/shinobu/packages/model-runtime/src/browser';
import type {PlatformProvider,PipelineCanvas} from '../../../../../third_party/shinobu/packages/image-pipeline/src/runtime/platform';
import type {Rect,TextRegion} from '../../../../../third_party/shinobu/packages/image-pipeline/src/types';
import {detectByOnnx} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/detect/onnxDetect';
import {detectBubbles,matchRegionsToBubbles} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/bubbleDetect';
import {runOcr} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/ocr/index';
import {mergeTextLines} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/textlineMerge/index';
import {filterOcrRegions} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/ocrPostFilter/index';
import {sortRegionsForRender} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/readingOrder';
import {hasTranslatableText} from '../../../../../third_party/shinobu/packages/image-pipeline/src/translatableText';
import {refineTextMask} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/maskRefinement/index';
import {runInpaint} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/inpaint';
import {drawTypeset} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/drawTypeset';
import {bitmapPng,type PngPatch} from '../../../../../../../shared/translation-images/png';
import type {TextRegion as TextInput} from './text/protocol';
import {pageBands,reconcileOverlap,textId,type DetectedBand} from './page-bands';
import {drawLatinTypeset} from './latin-typeset';
import type {LocalStage} from './failure-code';

const ocrProvider='paddleocr_v6_medium';
const png=(canvas:PipelineCanvas)=>canvas.convertToBlob!({type:'image/png'});
async function recognizeBatches(lines:TextRegion[],size:number,run:(batch:TextRegion[])=>Promise<{regions:TextRegion[]}>){
  const result:TextRegion[]=[];
  for(let i=0;i<lines.length;i+=size)result.push(...(await run(lines.slice(i,i+size))).regions);
  return result;
}
async function withImage<T>(base:ImageBitmap,r:Rect,run:(image:BitmapPipelineImage)=>Promise<T>){
  const full=r.width===base.width&&r.height===base.height;
  const image=new BitmapPipelineImage(full?base:await createImageBitmap(base,r.x,r.y,r.width,r.height),'');
  try{return await run(image);}finally{if(!full)image.close();}
}
async function drawBlob(canvas:PipelineCanvas,blob:Blob){
  const bitmap=await createImageBitmap(blob);
  try{canvas.getContext('2d')!.drawImage(bitmap,0,0);}finally{bitmap.close();}
}

export async function processPage(source:Blob,platform:PlatformProvider,runtime:ModelRuntime,language:string,filter:'balanced'|'off',
  progress:(stage:LocalStage)=>void,translate:(regions:TextInput[])=>Promise<Record<string,string>>,signal:AbortSignal){
  const stage=(value:LocalStage)=>{signal.throwIfAborted();progress(value);};
  stage('load');
  const base=await createImageBitmap(source,{imageOrientation:'from-image'});
  const canvas=(r:Rect)=>platform.createCanvas(r.width,r.height);
  try{
    const bands:DetectedBand[]=[];
    for(const rect of pageBands(base.width,base.height)){
      stage('detect');
      const {regions,rawMaskCanvas}=await withImage(base,rect,image=>detectByOnnx(image,platform,runtime));
      try{
        if(regions.length&&!rawMaskCanvas)throw Error('PIPELINE_DETECT');
        const band={rect,regions,mask:regions.length?await png(rawMaskCanvas!):undefined};
        if(bands.length)reconcileOverlap(bands[bands.length-1],band);
        bands.push(band);
      }finally{rawMaskCanvas?.dispose?.();}
    }

    const prepared:{rect:Rect;regions:TextRegion[];clean:Blob}[]=[];
    const text:TextInput[]=[];
    for(const band of bands){
      if(!band.regions.length)continue;
      const {rect}=band;
      await withImage(base,rect,async image=>{
        stage('bubble');
        const {bubbles}=await detectBubbles(image,platform,runtime);
        const lines=await recognizeBatches(band.regions,16,batch=>{
          stage('ocr');return runOcr(image,batch,ocrProvider,platform,undefined,runtime);
        });
        if(!lines.length)return;
        stage('merge');
        let regions=mergeTextLines(lines,rect.width,rect.height);
        matchRegionsToBubbles(regions,bubbles);
        const mask=canvas(rect),original=canvas(rect);
        try{
          await drawBlob(mask,band.mask!);
          original.getContext('2d')!.drawImage(image,0,0);
          if(filter==='balanced'){
            // The filter builds three OCR variants per candidate.
            try{regions=await recognizeBatches(regions,5,batch=>{
              stage('ocr_postfilter');return filterOcrRegions(image,mask,batch,{platform,modelRuntime:runtime,providerName:ocrProvider});
            });}
            catch{signal.throwIfAborted();} // This optional filter must preserve the initial OCR on a failed second opinion.
          }
          stage('order');
          regions=sortRegionsForRender(regions,original,platform);
          if(!hasTranslatableText({ordered:regions}))return;
          stage('mask_refine');
          const {refinedMaskCanvas}=refineTextMask(original,regions.filter(r=>r.sourceText.trim()),mask,platform,{method:'fit_text',kernelSize:3},false);
          try{
            stage('inpaint');
            const {canvas:clean}=await runInpaint(original,refinedMaskCanvas,platform,runtime);
            try{prepared.push({rect,regions,clean:await png(clean)});}finally{clean.dispose?.();}
          }finally{refinedMaskCanvas.dispose?.();}
          for(const region of regions){
            region.id=textId(rect,region,text.length);
            text.push({id:region.id,sourceText:region.sourceText});
          }
        }finally{mask.dispose?.();original.dispose?.();}
      });
      band.mask=undefined;
    }
    if(!text.length)return null;
    signal.throwIfAborted();
    const translated=await translate(text),patches:PngPatch[]=[];
    for(const {rect,regions,clean} of prepared){
      stage('typeset');
      for(const region of regions){
        if(typeof translated[region.id]!=='string')throw Error('TEXT_OUTPUT_INVALID');
        region.translatedText=translated[region.id];
      }
      const input=canvas(rect);
      let result=input;
      try{
        await drawBlob(input,clean);
        if(language==='en'||language==='es')drawLatinTypeset(input,regions);
        else result=(await drawTypeset(input,regions,language,undefined,platform)).canvas;
        if(bands.length===1){stage('finalize');return await png(result);}
        // Snapshot the ink before reusing the input surface; overlap margins must not erase neighbouring dialogue.
        const out=result.getContext('2d')!,delta=out.getImageData(0,0,rect.width,rect.height),ctx=input.getContext('2d')!;
        ctx.globalCompositeOperation='copy';ctx.drawImage(base,rect.x,rect.y,rect.width,rect.height,0,0,rect.width,rect.height);
        const orig=ctx.getImageData(0,0,rect.width,rect.height).data;
        for(let i=0;i<orig.length;i+=4)delta.data[i+3]=orig[i]!==delta.data[i]||orig[i+1]!==delta.data[i+1]||orig[i+2]!==delta.data[i+2]?255:0;
        out.putImageData(delta,0,0);patches.push({...rect,blob:await png(result)});
      }finally{if(result!==input)result.dispose?.();input.dispose?.();}
    }
    stage('finalize');
    return await bitmapPng(base,patches);
  }finally{base.close();}
}
