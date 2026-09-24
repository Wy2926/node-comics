import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {fetchSourceImage} from '../src/sources/runtime/image-fetch';
import {ImagePermissionsRequired} from '../src/sources/runtime/permissions';
import {imageReferer} from '../src/sources/shared/referrer';
const fixture=vi.hoisted(()=>({headers:[] as Record<string,string>[]}));
vi.mock('../src/sources/runtime/image-headers',()=>({withImageHeaders:async(_url:string,headers:Record<string,string>,_signal:AbortSignal,read:()=>Promise<unknown>)=>{fixture.headers.push(headers);return read();}}));
beforeEach(()=>{
  fixture.headers=[];
  vi.stubGlobal('chrome',{permissions:{contains:vi.fn(async()=>true)}});
});
afterEach(()=>vi.unstubAllGlobals());
const source='https://reader.test/chapter/1?key=test#page-2',image='https://cdn.test/page.png';

describe('common image request context',()=>{
  it('reads a generic cross-origin image with page origin, independently of adapters',async()=>{
    const fetch=vi.fn(async()=>new Response('image'));vi.stubGlobal('fetch',fetch);
    expect(await(await fetchSourceImage(image,undefined,undefined,{pageUrl:source})).blob.text()).toBe('image');
    expect(fixture.headers).toEqual([{referer:'https://reader.test/'}]);
    expect(fetch).toHaveBeenCalledWith(image,expect.objectContaining({redirect:'manual',cache:'no-store',credentials:'include',referrerPolicy:'no-referrer'}));
  });
  it('checks permission at every redirect hop, before requesting the next host',async()=>{
    const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://ungranted.test/next.png'}}));vi.stubGlobal('fetch',fetch);
    vi.mocked(chrome.permissions.contains).mockImplementation(async permission=>!permission.origins?.includes('https://ungranted.test/*'));
    await expect(fetchSourceImage(image)).rejects.toMatchObject({origins:['https://ungranted.test/*']});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not forward adapter headers to a different redirect origin',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://new-cdn.test/image'}})).mockResolvedValueOnce(new Response('image')));
    await fetchSourceImage(image,undefined,{Referer:'https://special.test/',Authorization:'fixture-only'},{pageUrl:source});
    expect(fixture.headers).toEqual([{referer:'https://special.test/',authorization:'fixture-only'},{referer:'https://reader.test/'}]);
  });
  it('retains the source context across same-origin relative redirects',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(null,{status:307,headers:{location:'/next.png'}})).mockResolvedValueOnce(new Response('image')));
    await fetchSourceImage(image,undefined,{referer:'https://special.test/'},{pageUrl:source});
    expect(fixture.headers).toEqual([{referer:'https://special.test/'},{referer:'https://special.test/'}]);
  });
  it.each([image,'javascript:alert(1)','https://user:secret@cdn.test/image'])('rejects looping or unsafe redirect %s',async location=>{
    const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location}}));vi.stubGlobal('fetch',fetch);
    await expect(fetchSourceImage(image)).rejects.toThrow(/重定向/);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a revoked permission without starting a network request',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);vi.mocked(chrome.permissions.contains).mockImplementation(async()=>false);
    await expect(fetchSourceImage(image)).rejects.toBeInstanceOf(ImagePermissionsRequired);expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves actionable HTTP failures and bounds response bytes',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response('denied',{status:403})).mockResolvedValueOnce(new Response('too large',{headers:{'content-length':String(41*1024*1024)}})));
    await expect(fetchSourceImage(image)).rejects.toThrow('403');await expect(fetchSourceImage(image)).rejects.toThrow('40 MB');
  });
  it('aborts before requesting and keeps page data outside host permissions',async()=>{
    const fetch=vi.fn(async()=>new Response('pixels'));vi.stubGlobal('fetch',fetch);
    const controller=new AbortController();controller.abort();
    await expect(fetchSourceImage(image,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(fetch).not.toHaveBeenCalled();
    await fetchSourceImage('data:image/png;base64,YQ==');expect(chrome.permissions.contains).not.toHaveBeenCalled();
  });
});

describe('Referer policy',()=>{
  it.each([
    ['no-referrer',image,undefined],['same-origin',image,undefined],['origin',image,'https://reader.test/'],
    ['strict-origin',image,'https://reader.test/'],['unsafe-url',image,source.split('#')[0]],
    ['strict-origin-when-cross-origin','https://reader.test/image',source.split('#')[0]],
    ['strict-origin-when-cross-origin','http://cdn.test/image',undefined],
    ['origin-when-cross-origin',image,'https://reader.test/'],
  ] as const)('%s for %s', (policy,url,expected)=>expect(imageReferer(source,url,policy)).toBe(expected));
});
