import {afterEach,describe,expect,it,vi} from 'vitest';
import {readInlineSourceImage} from '../../../runtime/source-image';
import {fetchSourceImage} from '../../../runtime/image-fetch';

vi.mock('../../../runtime/image-fetch',()=>({fetchSourceImage:vi.fn(async()=>({blob:new Blob(['image'],{type:'image/webp'}),headers:new Headers()}))}));
afterEach(()=>vi.clearAllMocks());
const chapter='https://comix.to/title/nr83-the-sword-bearing-flower/11372843-chapter-60';
const url='https://images.wowpic2.store/fixture.webp';
describe('site-specific inline HTTP image requests',()=>{
  it('uses the selected adapter Referer for real HTTP images',async()=>{
    const signal=new AbortController().signal;
    expect(await readInlineSourceImage(url,chapter,signal)).toEqual(new Blob(['image'],{type:'image/webp'}));
    expect(fetchSourceImage).toHaveBeenCalledExactlyOnceWith(url,signal,{referer:'https://comix.to/'},{pageUrl:chapter,referrerPolicy:undefined});
  });
  it('does not lend site headers to unknown or spoofed websites',async()=>{
    await readInlineSourceImage(url,'https://unknown.test/comic');
    await readInlineSourceImage(url,chapter.replace('comix.to','comix.to.evil.test'));
    expect(fetchSourceImage).toHaveBeenNthCalledWith(1,url,undefined,undefined,{pageUrl:'https://unknown.test/comic',referrerPolicy:undefined});
    expect(fetchSourceImage).toHaveBeenNthCalledWith(2,url,undefined,undefined,{pageUrl:chapter.replace('comix.to','comix.to.evil.test'),referrerPolicy:undefined});
  });
  it.each(['https://comix.to/browse','https://comix.to/title/nr83-the-sword-bearing-flower'])('rejects non-reader activation %s',async pageUrl=>{
    await expect(readInlineSourceImage(url,pageUrl)).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
    expect(fetchSourceImage).not.toHaveBeenCalled();
  });
  it('keeps page pixels on the document-bound path and aborts before requesting',async()=>{
    await expect(readInlineSourceImage('page-image:fixture',chapter)).rejects.toThrow();
    const controller=new AbortController();controller.abort();
    await expect(readInlineSourceImage(url,chapter,controller.signal)).rejects.toThrow();
    expect(fetchSourceImage).not.toHaveBeenCalled();
  });
});
