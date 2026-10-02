import {hashFile} from './hash';
import {INPUT_PROFILE,LEGACY_INPUT_PROFILE,TRANSLATION_JPEG_MAX_DIMENSION,TRANSLATION_JPEG_QUALITY,TRANSLATION_MAX_BYTES,TRANSLATION_WEBP_QUALITY,type InputProfile} from './limits';
import {bitmapPng} from './png';
import {probeImageMetadata} from './image-metadata';
export {ImageOutputTooLargeError} from './png';

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

/** Canvas JPEGs have sRGB pixels; strip optional EXIF/ICC without another pixel encode. */
export async function canvasJpeg(blob:Blob):Promise<Blob>{
  if(blob.type!=='image/jpeg')throw Error('JPEG encoder unavailable');
  const start=new Uint8Array(await blob.slice(0,2).arrayBuffer());
  if(start[0]!==255||start[1]!==0xd8)throw Error('Invalid JPEG');
  const parts:BlobPart[]=[blob.slice(0,2)];let changed=false;
  for(let at=2;at<blob.size;){
    const header=new Uint8Array(await blob.slice(at,at+4).arrayBuffer()),marker=header[1];
    if(header.length<2||header[0]!==255)throw Error('Invalid JPEG marker');
    if(marker===0xda||marker===0xd9){parts.push(blob.slice(at));return changed?new Blob(parts,{type:'image/jpeg'}):blob;}
    if(marker===255){parts.push(blob.slice(at,at+1));at++;continue;}
    if(marker===1||marker>=0xd0&&marker<=0xd7){parts.push(blob.slice(at,at+2));at+=2;continue;}
    if(header.length!==4)throw Error('Invalid JPEG header');
    const length=new DataView(header.buffer).getUint16(2),end=at+2+length;
    if(length<2||end>blob.size)throw Error('Invalid JPEG length');
    if(marker===0xe1||marker===0xe2)changed=true;else parts.push(blob.slice(at,end));
    at=end;
  }
  throw Error('Incomplete JPEG');
}

/** One WebP or long-image JPEG encode, with optional resize. No repeated quality search. */
export async function resizeInput(blob:Blob,width:number,height:number,profile:InputProfile=INPUT_PROFILE) {
  const long=Math.max(width,height)>16383,legacy=profile===LEGACY_INPUT_PROFILE;
  if(long&&!legacy&&Math.max(width,height)>TRANSLATION_JPEG_MAX_DIMENSION)throw Error('IMAGE_DIMENSIONS_LIMIT');
  const bitmap=await createImageBitmap(blob,{imageOrientation:'from-image',colorSpaceConversion:'default',resizeWidth:width,resizeHeight:height,resizeQuality:'high'});
  let canvas:OffscreenCanvas|undefined;
  try {
    if(long&&legacy){
      const output=await bitmapPng(bitmap,[],TRANSLATION_MAX_BYTES);
      return {blob:output,sha256:await hashFile(output)};
    }
    canvas=new OffscreenCanvas(width,height);
    const context=canvas.getContext('2d',{colorSpace:'srgb'});
    if(!context)throw Error('Image canvas unavailable');
    if(long){context.fillStyle='#fff';context.fillRect(0,0,width,height);}
    context.drawImage(bitmap,0,0,width,height);
    const output=long
      ?await canvasJpeg(await canvas.convertToBlob({type:'image/jpeg',quality:TRANSLATION_JPEG_QUALITY}))
      :await canvasWebp(await canvas.convertToBlob({type:'image/webp',quality:TRANSLATION_WEBP_QUALITY}));
    if(long){
      const dimensions=await probeImageMetadata(output);
      if(dimensions?.width!==width||dimensions.height!==height)throw Error('JPEG encoder changed image dimensions');
    }
    return {blob:output,sha256:await hashFile(output)};
  } finally {bitmap.close();if(canvas)canvas.width=canvas.height=1;}
}
