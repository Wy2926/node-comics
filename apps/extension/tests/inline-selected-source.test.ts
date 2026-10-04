import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {SourceImageAdapter} from '../src/sources/contracts/image';

const fixture=vi.hoisted(()=>({
  fetch:vi.fn(),resolve:vi.fn(),headers:vi.fn(),decode:vi.fn(),
  images:{} as Record<string,SourceImageAdapter>,
}));
vi.mock('../src/sources/runtime/image-fetch',()=>({fetchSourceImage:fixture.fetch}));
vi.mock('../src/sources/core/resolve',()=>({resolveSource:fixture.resolve}));
vi.mock('../src/sources/registry/definitions',()=>({definitions:[]}));
vi.mock('../src/sources/registry/images',()=>({sourceImages:fixture.images}));
vi.mock('../src/sources/runtime/client',()=>({sourceMessage:vi.fn()}));
vi.mock('../src/sources/runtime/permissions',()=>({requireImagePermissions:vi.fn()}));
import {readInlineSourceImage} from '../src/sources/runtime/source-image';

const imageUrl='https://images.test/image.png',pageUrl='https://fixture.test/read';
const input=new Blob(['displayed image'],{type:'image/png'}),decoded=new Blob(['canvas original'],{type:'image/png'});
const responseHeaders=new Headers({'x-image-recipe':'fixture'});
const requestHeaders={referer:'https://fixture.test/'};
const resolved=(inline:boolean,kind:string)=>({definition:{id:'fixture',capabilities:{inline}},location:{kind}});

beforeEach(()=>{
  vi.resetAllMocks();
  fixture.resolve.mockReturnValue(resolved(true,'reader'));
  fixture.headers.mockReturnValue(requestHeaders);
  fixture.fetch.mockResolvedValue({blob:input,headers:responseHeaders});
  fixture.decode.mockResolvedValue(decoded);
  fixture.images.fixture={headers:fixture.headers,decodeInline:fixture.decode};
});

describe('selected image source transport',()=>{
  it('reads an explicit image on a known catalog with its source headers and page referrer policy',async()=>{
    const catalogUrl='https://fixture.test/catalog',signal=new AbortController().signal;
    fixture.resolve.mockReturnValue(resolved(false,'catalog'));
    expect(await readInlineSourceImage(imageUrl,catalogUrl,signal,'strict-origin',true)).toBe(input);
    expect(fixture.resolve).toHaveBeenCalledExactlyOnceWith(catalogUrl,[]);
    expect(fixture.headers).toHaveBeenCalledExactlyOnceWith(imageUrl);
    expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(imageUrl,signal,requestHeaders,
      {pageUrl:catalogUrl,referrerPolicy:'strict-origin'});
    expect(fixture.decode).not.toHaveBeenCalled();
  });

  it.each([{inline:false,kind:'reader'},{inline:true,kind:'catalog'},{inline:false,kind:'other'}])(
    'keeps ordinary inline source restrictions: %j',async({inline,kind})=>{
      fixture.resolve.mockReturnValue(resolved(inline,kind));
      await expect(readInlineSourceImage(imageUrl,pageUrl)).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
      expect(fixture.headers).not.toHaveBeenCalled();
      expect(fixture.fetch).not.toHaveBeenCalled();
    });

  it('preserves the displayed IMG bytes in explicit mode while ordinary reader targets retain their canvas decoder',async()=>{
    const signal=new AbortController().signal;
    expect(await readInlineSourceImage(imageUrl,pageUrl,signal,'no-referrer',true)).toBe(input);
    expect(fixture.decode).not.toHaveBeenCalled();
    expect(await readInlineSourceImage(imageUrl,pageUrl,signal,'no-referrer')).toBe(decoded);
    expect(fixture.decode).toHaveBeenCalledExactlyOnceWith(input,responseHeaders,imageUrl,signal);
    expect(fixture.fetch).toHaveBeenNthCalledWith(1,imageUrl,signal,requestHeaders,{pageUrl,referrerPolicy:'no-referrer'});
    expect(fixture.fetch).toHaveBeenNthCalledWith(2,imageUrl,signal,requestHeaders,{pageUrl,referrerPolicy:'no-referrer'});
  });

  it('passes static source headers through the same transport for an explicit image',async()=>{
    fixture.images.fixture={headers:requestHeaders,decodeInline:fixture.decode};
    expect(await readInlineSourceImage(imageUrl,pageUrl,undefined,'same-origin',true)).toBe(input);
    expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(imageUrl,undefined,requestHeaders,
      {pageUrl,referrerPolicy:'same-origin'});
    expect(fixture.decode).not.toHaveBeenCalled();
  });

  it.each(['javascript:alert(1)','data:image/png;base64,YQ==','blob:https://fixture.test/image',
    'https://user:secret@images.test/image.png','ftp://images.test/image.png','/relative.png'])(
    'rejects an unsafe or unbound image URL even in explicit mode: %s',async unsafeUrl=>{
      await expect(readInlineSourceImage(unsafeUrl,pageUrl,undefined,undefined,true)).rejects.toThrow('SOURCE_RESOURCE_EXPIRED');
      expect(fixture.headers).not.toHaveBeenCalled();
      expect(fixture.fetch).not.toHaveBeenCalled();
      expect(fixture.decode).not.toHaveBeenCalled();
    });

  it('does not resolve or fetch after cancellation',async()=>{
    const controller=new AbortController();controller.abort();
    await expect(readInlineSourceImage(imageUrl,pageUrl,controller.signal,undefined,true)).rejects.toMatchObject({name:'AbortError'});
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('discards source bytes when cancellation arrives during the transport read',async()=>{
    const controller=new AbortController();
    fixture.fetch.mockImplementation(async()=>{controller.abort();return {blob:input,headers:responseHeaders};});
    await expect(readInlineSourceImage(imageUrl,pageUrl,controller.signal,'origin',true)).rejects.toMatchObject({name:'AbortError'});
    expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(imageUrl,controller.signal,requestHeaders,
      {pageUrl,referrerPolicy:'origin'});
    expect(fixture.decode).not.toHaveBeenCalled();
  });

  it('keeps transport failures visible without applying the canvas decoder',async()=>{
    fixture.fetch.mockRejectedValue(Error('Image permission denied'));
    await expect(readInlineSourceImage(imageUrl,pageUrl,undefined,undefined,true)).rejects.toThrow('Image permission denied');
    expect(fixture.decode).not.toHaveBeenCalled();
  });
});
