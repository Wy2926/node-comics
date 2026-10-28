import {expect,it,vi} from 'vitest';
import {configureTypesetFont,supportedTypesetText} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/fontRuntime';
import {drawTypeset} from '../../../../../third_party/shinobu/packages/image-pipeline/src/pipeline/typeset/drawTypeset';
import type {PlatformProvider,PipelineCanvas} from '../../../../../third_party/shinobu/packages/image-pipeline/src/runtime/platform';

it('skips only unsupported code points, preserving adjacent text and whitespace',()=>{
  configureTypesetFont('fixture',400,[[0x41,0x5a],[0x4e00,0x9fff],[0x20000,0x20000]]);
  expect(supportedTypesetText('A🧪𠀀中𒀀B\n 文')).toBe('A𠀀中B\n 文');
});

it('does not redraw source text when every translated character is missing',async()=>{
  configureTypesetFont('fixture',400,[[0x4e00,0x9fff]]);
  const drawImage=vi.fn(),measureText=vi.fn(()=>{throw Error('Empty text must not be laid out');});
  const platform={waitForFonts:async()=>{},createCanvas:(width:number,height:number)=>({width,height,getContext:()=>({drawImage,measureText})})} as unknown as PlatformProvider;
  const source={width:200,height:200} as PipelineCanvas;
  for(const direction of ['h','v'] as const){
    await drawTypeset(source,[{id:'empty',box:{x:0,y:0,width:100,height:100},direction,sourceText:'原文',translatedText:'🧪'}],'zh',undefined,platform);
  }
  expect(drawImage).toHaveBeenCalledTimes(2);expect(measureText).not.toHaveBeenCalled();
});
