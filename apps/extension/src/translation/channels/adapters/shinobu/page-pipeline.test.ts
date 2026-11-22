import {afterEach,assert,expect,it,vi} from 'vitest';
import {processPage} from './page-pipeline';
import * as detection from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/detect/onnxDetect';
import * as bubbles from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/bubbleDetect';
import * as ocr from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/ocr/index';
import * as refinement from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/maskRefinement/index';
import * as paint from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/inpaint';
import * as typeset from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/drawTypeset';
import * as latin from './latin-typeset';
import * as output from '../../../../../../../shared/translation-images/png';
import type {BitmapPipelineImage} from '../../../../../third_party/shinobu/apps/web/src/runtime/offscreenPlatform';
import type {PipelineCanvas,PlatformProvider} from '../../../../../third_party/shinobu/packages/image-pipeline/src/runtime/platform';
import type {ModelRuntime} from '../../../../../third_party/shinobu/packages/model-runtime/src/browser';
import type {TextRegion} from './text/protocol';

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it.each([['zh',false],['en',false],['es',false],['es',true]] as const)('submits a whole strip for %s only after preparation (last band fails: %s)',async(language,failLast)=>{
  const source=new Blob(['strip']),close=vi.fn(),painted:string[]=[];
  vi.stubGlobal('createImageBitmap',async(_input:unknown,_x:unknown,y=0,width=240,height=2600)=>({y,width,height,close}));
  const platform={createCanvas:(width:number,height:number)=>{
    const pixels=new Uint8ClampedArray(width*height*4);
    const ctx={drawImage(){pixels.fill(0);pixels[3]=pixels[7]=255;},fillRect(){pixels[0]=42;},
      putImageData({data}:{data:Uint8ClampedArray}){pixels.set(data);},getImageData:()=>({data:pixels.slice()})};
    return {width,height,getContext:()=>ctx,convertToBlob:async()=>new Blob([pixels.slice(0,8)])};
  }} as unknown as PlatformProvider;
  vi.spyOn(detection,'detectByOnnx').mockImplementation(async image=>{
    const y=((image as BitmapPipelineImage).bitmap as ImageBitmap&{y:number}).y;
    // The first band is blank; the line at 1300 is visible to two detectors.
    const regions=[1300,2350].filter(at=>at>=y&&at+20<=y+image.naturalHeight).map(at=>({
      id:crypto.randomUUID(),box:{x:20,y:at-y,width:90,height:20},sourceText:String(at),translatedText:'',
    }));
    return {regions,rawMaskCanvas:platform.createCanvas(240,image.naturalHeight)};
  });
  vi.spyOn(bubbles,'detectBubbles').mockResolvedValue({bubbles:[],actualProvider:'webgpu'});
  vi.spyOn(ocr,'runOcr').mockImplementation(async(_image,regions)=>({regions,actualProvider:'webgpu',debug:{} as ocr.OcrResult['debug']}));
  vi.spyOn(refinement,'refineTextMask').mockImplementation(canvas=>({refinedMaskCanvas:canvas}));
  const clean=vi.spyOn(paint,'runInpaint').mockImplementation(async canvas=>{
    if(failLast&&clean.mock.calls.length===2)throw Error('last band failed');
    return {canvas,actualProvider:'webgpu'};
  });
  const letter=(canvas:PipelineCanvas,regions:{translatedText:string}[])=>{
    painted.push(...regions.map(r=>r.translatedText));canvas.getContext('2d')!.fillRect(0,0,1,1);
  };
  vi.spyOn(latin,'drawLatinTypeset').mockImplementation(letter);
  vi.spyOn(typeset,'drawTypeset').mockImplementation(async(input,regions)=>{
    const canvas=platform.createCanvas(input.width,input.height);
    canvas.getContext('2d')!.drawImage(input,0,0);letter(canvas,regions);return {canvas,debugLog:null};
  });
  const image=new Blob(['painted'],{type:'image/png'}),png=vi.spyOn(output,'bitmapPng').mockResolvedValue(image);
  const translate=vi.fn(async(regions:TextRegion[])=>{
    expect(clean).toHaveBeenCalledTimes(2);expect(regions.map(r=>r.sourceText)).toEqual(['1300','2350']);
    return Object.fromEntries(regions.map(r=>[r.id,'translated '+r.sourceText]));
  });
  const task=processPage(source,platform,{} as ModelRuntime,language,'off',()=>{},translate,new AbortController().signal);
  if(failLast){
    await expect(task).rejects.toThrow('last band failed');expect(translate).not.toHaveBeenCalled();expect(png).not.toHaveBeenCalled();
  }else{
    await expect(task).resolves.toBe(image);expect(translate).toHaveBeenCalledOnce();
    expect(painted).toEqual(['translated 1300','translated 2350']);expect(png.mock.calls[0][1]).toHaveLength(2);
    for(const patch of png.mock.calls[0][1]??[]){
      assert('blob' in patch);
      expect([...new Uint8Array(await patch.blob.arrayBuffer())]).toEqual([42,0,0,255,0,0,0,0]);
    }
    expect(latin.drawLatinTypeset).toHaveBeenCalledTimes(language==='zh'?0:2);
  }
  expect(close).toHaveBeenCalled();
});
