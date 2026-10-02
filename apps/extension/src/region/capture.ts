import {assertCurrent} from '../concurrency';
import {hashFile} from '../importers/hash';
import {imageWork} from '../translation/input/work';
import {cropGeometry} from './geometry';
import type {RegionRect,RegionViewport} from './protocol';

/** Only the cropped PNG leaves this trusted extension context. */
export async function captureRegion(windowId:number,rect:RegionRect,viewport:RegionViewport,current:()=>boolean) {
  assertCurrent(current);
  let data=await chrome.tabs.captureVisibleTab(windowId,{format:'png'});
  assertCurrent(current);
  const response=await fetch(data);data='';
  const screenshot=await response.blob();
  return imageWork(async()=>{
    assertCurrent(current);
    const bitmap=await createImageBitmap(screenshot);
    let canvas:OffscreenCanvas|undefined;
    try{
      assertCurrent(current);
      const box=cropGeometry(rect,viewport,bitmap.width,bitmap.height);
      canvas=new OffscreenCanvas(box.pixels.width,box.pixels.height);
      const context=canvas.getContext('2d');if(!context)throw Error('REGION_CAPTURE_FAILED');
      context.drawImage(bitmap,box.pixels.x,box.pixels.y,box.pixels.width,box.pixels.height,0,0,box.pixels.width,box.pixels.height);
      const blob=await canvas.convertToBlob({type:'image/png'});assertCurrent(current);
      return {blob,rect:box.rect,width:box.pixels.width,height:box.pixels.height,sha256:await hashFile(blob)};
    }finally{bitmap.close();if(canvas){canvas.width=1;canvas.height=1;}}
  });
}
