/** Same integer shuffle as the site's buildOrderV2; no WebAssembly dependency. */
export function tileOrder(seed:number,count:number) {
  let state=(seed|1)>>>0;
  const order=Array.from({length:count},(_,i)=>i);
  for(let i=count-1;i>0;i--){
    state=(state^(state<<13))>>>0;state=(state^(state>>>17))>>>0;state=(state^(state<<5))>>>0;
    const j=state%(i+1);[order[i],order[j]]=[order[j],order[i]];
  }
  return order;
}
/** The response hash selects a seed mask; it does not change the image bytes or grid algorithm. */
export function imageSeed(seed:number,hash:string|null) {
  const mask=hash==='03632'?58414:hash==='02900'?117532:0;
  return (seed^mask)>>>0;
}
export async function decodeImage(blob:Blob,headers:Headers,processing?:string,signal?:AbortSignal):Promise<Blob>{
  signal?.throwIfAborted();
  if(processing===undefined)return blob;
  if(processing!=='tiles-v1')throw Error('Comix 图片处理格式不受支持。');
  const seedText=headers.get('X-Scramble-Seed'),grid=headers.get('X-Scramble-Grid'),algo=headers.get('X-Scramble-Algo');
  if(!seedText||!/^\d+$/.test(seedText)||Number(seedText)>0xffffffff||!grid||!/^\d+x\d+$/.test(grid)||algo!=='3')throw Error('Comix 图片还原协议已变化，请更新适配器。');
  const [cols,rows]=grid.split('x').map(Number);
  if(cols<1||rows<1||cols*rows>256)throw Error('Comix 图片网格无效。');
  const bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none'});
  try{
    signal?.throwIfAborted();
    const {width,height}=bitmap;
    if(width*height>60_000_000||width<cols||height<rows)throw Error('Comix 图片尺寸无效。');
    const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{colorSpace:'srgb'});
    if(!ctx)throw Error('图片还原不可用。');
    ctx.drawImage(bitmap,0,0); // Preserve the remainder pixels outside the equal-sized grid.
    const w=Math.floor(width/cols),h=Math.floor(height/rows);
    const seed=imageSeed(Number(seedText),headers.get('X-Scramble-Hash'));
    for(const [from,to] of tileOrder(seed,cols*rows).entries())
      ctx.drawImage(bitmap,from%cols*w,Math.floor(from/cols)*h,w,h,to%cols*w,Math.floor(to/cols)*h,w,h);
    const decoded=await canvas.convertToBlob({type:'image/png'});signal?.throwIfAborted();return decoded;
  }finally{bitmap.close();}
}
