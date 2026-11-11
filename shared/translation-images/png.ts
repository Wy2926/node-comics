import type {OverlayTile} from './tiles';
import {createImageCanvas} from './canvas';

export class ImageOutputTooLargeError extends Error {
  readonly code='IMAGE_OUTPUT_TOO_LARGE';
  constructor(){super('Composed image exceeds byte limit');this.name='ImageOutputTooLargeError';}
}
// Borrowed bitmaps remain owned by the caller; encoded tiles are decoded and closed here.
export type PngPatch=OverlayTile|(Omit<OverlayTile,'blob'>&{bitmap:ImageBitmap});

const crcTable=Uint32Array.from({length:256},(_,value)=>{
  for(let i=0;i<8;i++)value=value&1?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});
function chunk(name:string,data:Uint8Array):Blob {
  const type=new TextEncoder().encode(name),header=new Uint8Array(8),tail=new Uint8Array(4);
  new DataView(header.buffer).setUint32(0,data.length);header.set(type,4);
  let crc=0xffffffff;
  for(const bytes of [type,data])for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);
  new DataView(tail.buffer).setUint32(0,(crc^0xffffffff)>>>0);
  return new Blob([header,new Uint8Array(data),tail]);
}

/** Stream RGBA rows through small canvases; neither axis requires a full-page canvas. */
export async function bitmapPng(base:ImageBitmap,tiles:PngPatch[]=[],maxBytes=Infinity):Promise<Blob> {
  const {width,height}=base,stride=width*4,band=Math.max(1,Math.min(4096,Math.floor(4_194_304/width)));
  const ihdr=new Uint8Array(13),view=new DataView(ihdr.buffer);
  view.setUint32(0,width);view.setUint32(4,height);ihdr[8]=8;ihdr[9]=6;
  const parts:BlobPart[]=[new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr)];
  let y=0,compressedBytes=0,pendingBytes=0,canvas:OffscreenCanvas|HTMLCanvasElement|undefined;
  const pending=new Uint8Array(65536);
  const source=new ReadableStream<BufferSource>({
    async pull(controller){
      if(y>=height){controller.close();return;}
      const rows=Math.min(band,height-y),data=new Uint8Array(rows*(stride+1));
      const patches=tiles.filter(tile=>tile.y<y+rows&&tile.y+tile.height>y);
      for(let x=0;x<width;x+=2048){
        const columns=Math.min(2048,width-x);
        canvas??=createImageCanvas(columns,rows);canvas.width=columns;canvas.height=rows;
        const context=canvas.getContext('2d',{colorSpace:'srgb'}) as CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null;
        if(!context)throw Error('Image canvas unavailable');
        context.imageSmoothingEnabled=false;
        context.drawImage(base,x,y,columns,rows,0,0,columns,rows);
        context.globalCompositeOperation='source-atop';
        for(const tile of patches){
          if(tile.x>=x+columns||tile.x+tile.width<=x)continue;
          let decoded:ImageBitmap|undefined;
          try{
            const patch='bitmap' in tile?tile.bitmap:(decoded=await createImageBitmap(tile.blob));
            if(patch.width!==tile.width||patch.height!==tile.height)throw Error('Invalid tile dimensions');
            context.drawImage(patch,tile.x-x,tile.y-y);
          }finally{decoded?.close();}
        }
        const rgba=context.getImageData(0,0,columns,rows).data;
        for(let row=0;row<rows;row++)data.set(rgba.subarray(row*columns*4,(row+1)*columns*4),row*(stride+1)+1+x*4);
      }
      y+=rows;controller.enqueue(data);
    },
  },{highWaterMark:0});
  const reader=source.pipeThrough(new CompressionStream('deflate')).getReader();
  try{
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      compressedBytes+=value.length;
      if(45+compressedBytes+12*Math.ceil(compressedBytes/65536)>maxBytes)throw new ImageOutputTooLargeError();
      for(let offset=0;offset<value.length;){
        const take=Math.min(pending.length-pendingBytes,value.length-offset);
        pending.set(value.subarray(offset,offset+take),pendingBytes);pendingBytes+=take;offset+=take;
        if(pendingBytes===pending.length){parts.push(chunk('IDAT',pending));pendingBytes=0;}
      }
    }
    if(pendingBytes)parts.push(chunk('IDAT',pending.subarray(0,pendingBytes)));
    parts.push(chunk('IEND',new Uint8Array()));
    return new Blob(parts,{type:'image/png'});
  }finally{await reader.cancel().catch(()=>{});if(canvas)canvas.width=canvas.height=1;}
}
