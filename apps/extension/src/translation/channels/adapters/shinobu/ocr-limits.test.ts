import {expect,it} from 'vitest';
import {paddleocrV6MediumProvider} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/ocr/paddleocrProvider';
import type {PlatformProvider,PipelineImage} from '../../../../../third_party/shinobu/packages/image-pipeline/src/runtime/platform';
import type {ModelRuntime} from '../../../../../third_party/shinobu/packages/model-runtime/src/browser';

it('reads every thin line without an oversized perspective warp or GPU batch',async()=>{
  const pixels=(w:number,h:number)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)});
  const ctx={drawImage(){},getImageData:(_x:number,_y:number,w:number,h:number)=>pixels(w,h),createImageData:pixels,putImageData(){},translate(){},rotate(){}};
  const platform={createCanvas:(width:number,height:number)=>{
    if(width*height>320*48)throw Error('crop exceeds pixel budget');
    return {width,height,getContext:()=>ctx};
  }} as unknown as PlatformProvider;
  const batches:number[]=[];
  const runtime={readModel:async()=>({input:[48,320],dictUrl:'fixture:bounded-ocr'}),readTextResource:async()=>'A',
    getSession:async()=>({sessionId:'fixture:bounded-ocr',provider:'webgpu',inputNames:['images'],outputNames:['logits']}),
    run:async(_id:string,{images}:{images:{dims:number[]}})=>{
      const [batch]=images.dims;batches.push(batch);
      return {outputs:{logits:{type:'float32',dims:[batch,1,2],data:Float32Array.from({length:batch*2},(_,i)=>i%2)}}};
    }} as unknown as ModelRuntime;
  const image={naturalWidth:1500,naturalHeight:1500} as PipelineImage;
  const lines=Array.from({length:11},(_,i)=>({id:'line'+i,sourceText:'',translatedText:'',box:i%2?{x:i*7,y:4,width:2,height:1200}:{x:4,y:i*7,width:1200,height:2}}));
  const result=await paddleocrV6MediumProvider.recognize(image,lines,platform,runtime);
  expect(Math.max(...batches)).toBeLessThanOrEqual(4);
  expect(result.results.map(r=>[r.regionId,r.text])).toEqual(lines.map(r=>[r.id,'A']));
});
