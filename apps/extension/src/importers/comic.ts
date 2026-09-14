import {hashFile,Sha256} from './hash';

export * from './comic-shared';
import {MAX_FILE,MAX_PAGE,MiB,type ComicImport,type ComicPage} from './comic-shared';

// Canvas/font rasterization can differ across platforms even for the same PDF.
// Include actual page bytes so reimport never conflicts with a previous rendering.
export function importedFileHash(book:Pick<ComicImport,'format'|'fileHash'>,imageSha256:string) {
  return book.format==='PDF'?new Sha256().update(new TextEncoder().encode(`pdf-page-v1:${book.fileHash}:${imageSha256}`)).digest():book.fileHash;
}

export async function openComic(file:File, progress?:(done:number,total:number)=>void):Promise<ComicImport> {
  if(!file.size||file.size>MAX_FILE)throw Error('漫画文件为空或超过 512 MB，请拆分为章节后导入。');
  const extension=file.name.split('.').at(-1)!.toLowerCase();
  if(extension==='mobi') {
    const {importMobi}=await import('./mobi');
    const result=await importMobi(file,undefined,progress);
    return {...result,format:'MOBI',total:result.pages.length,close(){}};
  }
  const prefix=new Uint8Array(await file.slice(0,8).arrayBuffer());
  const signature=String.fromCharCode(...prefix);
  const format=['cbz','zip'].includes(extension)?'ZIP':['cbr','rar'].includes(extension)?'RAR':extension==='pdf'?'PDF':undefined;
  if(!format)throw Error('不支持此漫画文件格式。');
  if(format==='ZIP'&&!signature.startsWith('PK') || format==='RAR'&&!signature.startsWith('Rar!\x1a\x07') || format==='PDF'&&!signature.startsWith('%PDF-'))throw Error('文件内容与扩展名不符，或文件已损坏。');
  if(format==='RAR'&&file.size>128*MiB)throw Error('CBR/RAR 最大支持 128 MB，请拆分或转换为 CBZ/ZIP。');
  const fileHash=await hashFile(file,progress);
  const result=format==='ZIP'?await (await import('./zip')).openZip(file):format==='RAR'?await (await import('./rar')).openRar(file):await (await import('./pdf')).openPdf(file,fileHash);
  return {title:file.name.replace(/\.[^.]+$/,''),fileHash,format,warnings:[],...result};
}

/** Decode one page at a time; GIF normalization is also the upload identity. */
export async function prepareComicPage(item:ComicPage) {
  if(item.blob.size>MAX_PAGE)throw Error(`${item.name} 超过单页 32 MB 限制。`);
  if(item.width&&item.height)checkDimensions(item.width,item.height);
  let bitmap:ImageBitmap;
  try { bitmap=await createImageBitmap(item.blob); }
  catch { throw Error(`${item.name} 无法解码，请检查图片是否损坏。`); }
  try {
    const {width,height}=bitmap;
    checkDimensions(width,height);
    let blob=item.blob;
    if(blob.type==='image/gif') {
      const canvas=new OffscreenCanvas(width,height);
      canvas.getContext('2d')!.drawImage(bitmap,0,0);
      blob=await canvas.convertToBlob({type:'image/png'});
      canvas.width=canvas.height=1;
    }
    if(blob.size>MAX_PAGE)throw Error(`${item.name} 转换后超过单页 32 MB 限制。`);
    return {blob,width,height,imageSha256:await hashFile(blob)};
  } finally { bitmap.close(); }
}
function checkDimensions(width:number,height:number) {
  if(width<1||height<1||width*height>40_000_000||Math.max(width,height)>30000)throw Error('漫画页尺寸超过阅读器限制（4000 万像素、单边 30000）。');
}
