import {createExtractorFromData,type ArcFile} from 'node-unrar-js/esm/index.esm';
import {MAX_ENTRIES,MAX_PAGE,MiB,validateEntries,imageMime,type ComicPage} from './comic-shared';

export async function rarContents(data:ArrayBuffer,wasmBinary:ArrayBuffer) {
  const extractor=await createExtractorFromData({data,wasmBinary});
  const list=extractor.getFileList();
  if(list.arcHeader.flags.volume)throw Error('暂不支持 RAR 分卷，请合并为单个压缩包后导入。');
  if(list.arcHeader.flags.headerEncrypted)throw Error('暂不支持加密 RAR，请在本机解密后导入。');
  const entries=[];
  for(const header of list.fileHeaders) {
    if(entries.length>=MAX_ENTRIES)throw Error('压缩包目录超过 10000 项。');
    entries.push({name:header.name,size:header.unpSize,encrypted:header.flags.encrypted,directory:header.flags.directory});
  }
  const images=validateEntries(entries.filter(e=>!e.directory),256*MiB);
  const ordinals=new Map(images.map((image,index)=>[image.name,index]));
  // Pinned node-unrar-js 2.0.2 funnels every extracted byte through write().
  // Guard actual writes, not just attacker-controlled archive header sizes.
  const io=extractor as unknown as {write(fd:number,buf:number,size:number):boolean};
  const write=io.write.bind(extractor);let totalWritten=0,pageWritten=0;
  io.write=(fd,buf,size)=>{
    totalWritten+=size;pageWritten+=size;
    if(size<0||pageWritten>MAX_PAGE||totalWritten>256*MiB)throw Error('RAR 实际展开大小超过安全限制。');
    return write(fd,buf,size);
  };
  const files=extractor.extract({files:header=>ordinals.has(header.name)}).files;
  return {total:images.length,pages:(function*():Generator<ComicPage> {
    while(true) {
      pageWritten=0;
      const next:IteratorResult<ArcFile<Uint8Array>>=files.next();
      if(next.done)break;
      const {fileHeader,extraction}=next.value;
      if(!extraction||extraction.byteLength!==fileHeader.unpSize)throw Error('RAR 图片数据不完整。');
      yield {name:fileHeader.name,pageIndex:ordinals.get(fileHeader.name)!,blob:new Blob([new Uint8Array(extraction)],{type:imageMime(fileHeader.name)})};
    }
  })()};
}
