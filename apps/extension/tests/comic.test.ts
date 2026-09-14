import {describe,it,expect} from 'vitest';
import {ZipWriter,BlobWriter,TextReader} from '@zip.js/zip.js/index-native.js';
import {openComic,validateEntries,comparePaths,importedFileHash,MAX_PAGE,MiB} from '../src/importers/comic';
import {openZip} from '../src/importers/zip';

async function zip(names:string[],options:object={}) {
  const writer=new ZipWriter(new BlobWriter(),{useWebWorkers:false,...options});
  for(const name of names)await writer.add(name,new TextReader('image fixture bytes'),{level:6});
  return new File([await writer.close()],'comic.cbz');
}
describe('comic archives',()=>{
  it('separates changed PDF render bytes while retaining archive file identities',()=>{
    const book={format:'PDF',fileHash:'a'.repeat(64)};
    expect(importedFileHash(book,'b'.repeat(64))).toBe(importedFileHash(book,'b'.repeat(64)));
    expect(importedFileHash(book,'b'.repeat(64))).not.toBe(importedFileHash(book,'c'.repeat(64)));
    expect(importedFileHash({...book,format:'ZIP'},'b'.repeat(64))).toBe(book.fileHash);
  });
  it('reads actual deflated ZIP entries in natural path order and preserves bytes',async()=>{
    const result=await openComic(await zip(['10.png','__MACOSX/._01.png','2.png','.hidden.png','readme.txt','01.png']));
    try {
      expect(result.total).toBe(3);expect(result.fileHash).toMatch(/^[a-f0-9]{64}$/);
      const pages=[];for await(const page of result.pages)pages.push(page);
      expect(pages.map(p=>p.name)).toEqual(['01.png','2.png','10.png']);
      expect(pages.map(p=>p.pageIndex)).toEqual([0,1,2]);
      expect(await pages[0].blob.text()).toBe('image fixture bytes');
    } finally {await result.close();}
  });
  it('rejects encrypted, empty-image and corrupted archives',async()=>{
    await expect(openZip(await zip(['1.png'],{password:'local-test',zipCrypto:true}))).rejects.toThrow('加密');
    await expect(openZip(await zip(['metadata.txt']))).rejects.toThrow('没有');
    await expect(openComic(new File(['broken'],'book.cbz'))).rejects.toThrow('内容');
    await expect(openComic(new File(['%PDF-1.7'],'book.rar'))).rejects.toThrow('内容');
  });
  it('rejects CRC corruption while extracting',async()=>{
    const writer=new ZipWriter(new BlobWriter(),{useWebWorkers:false});
    await writer.add('1.png',new TextReader('unique-pixel-bytes'),{level:0});
    const bytes=new Uint8Array(await (await writer.close()).arrayBuffer());
    // ZIP headers are binary: UTF-8 character offsets are not byte offsets.
    const offset=Buffer.from(bytes).indexOf('unique-pixel-bytes');
    expect(offset).toBeGreaterThanOrEqual(0);bytes[offset]^=1;
    const result=await openZip(new Blob([bytes]));
    try {await expect((async()=>{for await(const _ of result.pages){/* consume CRC */}})()).rejects.toThrow();}
    finally {await result.close();}
  });
  it('bounds declared expansion, page count and ambiguous names',()=>{
    expect(()=>validateEntries([{name:'1.png',size:MAX_PAGE+1}])).toThrow('32 MB');
    expect(()=>validateEntries(Array.from({length:1501},(_,i)=>({name:`${i}.png`,size:1})))).toThrow('1500');
    expect(()=>validateEntries([{name:'a.png',size:20*MiB},{name:'b.png',size:20*MiB}],32*MiB)).toThrow('展开');
    expect(()=>validateEntries([{name:'a.png',size:1},{name:'a.png',size:1}])).toThrow('重名');
    expect([{name:'2.png'},{name:'02.png'},{name:'A/1.png'},{name:'a/1.png'}].sort(comparePaths).map(e=>e.name)).toEqual(['02.png','2.png','A/1.png','a/1.png']);
  });
});
