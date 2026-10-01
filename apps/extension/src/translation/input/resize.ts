import {hashFile} from '../../importers/hash';
import {TRANSLATION_WEBP_QUALITY} from './limits';

/** Only for our sRGB canvas output: remove redundant profiles without re-encoding pixels. */
export async function canvasWebp(blob:Blob):Promise<Blob>{
  if(blob.type!=='image/webp')throw Error('WebP encoder unavailable');
  const header=new Uint8Array(await blob.slice(0,12).arrayBuffer());
  const tag=(bytes:Uint8Array)=>String.fromCharCode(...bytes);
  if(header.length!==12||tag(header.subarray(0,4))!=='RIFF'||tag(header.subarray(8,12))!=='WEBP')throw Error('Invalid WebP');
  const parts:BlobPart[]=[header];let size=12,changed=false;
  for(let at=12;at<blob.size;){
    const chunk=new Uint8Array(await blob.slice(at,at+8).arrayBuffer());
    if(chunk.length!==8)throw Error('Invalid WebP chunk');
    const name=tag(chunk.subarray(0,4)),length=new DataView(chunk.buffer).getUint32(4,true),end=at+8+length+(length&1);
    if(end>blob.size)throw Error('Invalid WebP length');
    if(['ICCP','EXIF','XMP '].includes(name)){changed=true;}
    else if(name==='VP8X'){
      if(length!==10)throw Error('Invalid WebP extended header');
      const extended=new Uint8Array(await blob.slice(at,end).arrayBuffer());
      extended[8]&=~(0x20|0x08|0x04);parts.push(extended);size+=extended.length;
    }else{parts.push(blob.slice(at,end));size+=end-at;}
    at=end;
  }
  if(!changed)return blob;
  new DataView(header.buffer).setUint32(4,size-8,true);
  return new Blob(parts,{type:'image/webp'});
}

/** One high-quality WebP encode, with optional resize. No repeated quality search. */
export async function resizeInput(blob:Blob,width:number,height:number) {
  const bitmap=await createImageBitmap(blob,{imageOrientation:'from-image',colorSpaceConversion:'default',resizeWidth:width,resizeHeight:height,resizeQuality:'high'});
  let canvas:OffscreenCanvas|undefined;
  try {
    canvas=new OffscreenCanvas(width,height);
    const context=canvas.getContext('2d',{colorSpace:'srgb'});
    if(!context)throw Error('Image canvas unavailable');
    context.drawImage(bitmap,0,0,width,height);
    const output=await canvasWebp(await canvas.convertToBlob({type:'image/webp',quality:TRANSLATION_WEBP_QUALITY}));
    return {blob:output,sha256:await hashFile(output)};
  } finally {bitmap.close();if(canvas)canvas.width=canvas.height=1;}
}
