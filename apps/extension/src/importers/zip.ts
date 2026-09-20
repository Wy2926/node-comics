import {msg} from '../i18n/runtime';
import {BlobReader,ZipReader} from '@zip.js/zip.js/index-native.js';
import {imageMime,MAX_ENTRIES,MAX_PAGE,validateEntries,type ComicPage} from './comic-shared';

export async function openZip(file:Blob) {
  // Native deflate streams, without blob workers, eval or remote codec loading.
  const reader=new ZipReader(new BlobReader(file),{useWebWorkers:false,useCompressionStream:true,checkSignature:true});
  try {
    const entries=[];
    for await(const entry of reader.getEntriesGenerator()) {
      if(entries.length>=MAX_ENTRIES)throw Error(msg("压缩包目录超过 10000 项。"));
      entries.push({name:entry.filename,size:entry.uncompressedSize,encrypted:entry.encrypted,entry});
    }
    const images=validateEntries(entries.filter(e=>!e.entry.directory));
    return {total:images.length,close:()=>reader.close(),pages:(async function*():AsyncGenerator<ComicPage> {
      for(let pageIndex=0;pageIndex<images.length;pageIndex++) {
        const {entry,name,size}=images[pageIndex];
        const chunks:Uint8Array<ArrayBuffer>[]=[];let written=0;
        const stream=new WritableStream<Uint8Array>({write(chunk){
          written+=chunk.byteLength;
          if(written>MAX_PAGE||written>size)throw Error(msg("压缩包实际展开大小超过声明或安全限制。"));
          chunks.push(new Uint8Array(chunk));
        }});
        try {
          if(entry.directory)throw Error(msg("无效的图片目录项。"));
          await entry.getData(stream,{signal:AbortSignal.timeout(60000)});
          if(written!==size)throw Error(msg("展开后的图片大小与记录不符。"));
          yield {name,pageIndex,blob:new Blob(chunks,{type:imageMime(name)})};
        } catch(error) { throw Error(msg("无法读取 {0}：{1}", {"0": name, "1": (error as Error).message})); }
      }
    })()};
  } catch(error) {await reader.close();throw error;}
}
