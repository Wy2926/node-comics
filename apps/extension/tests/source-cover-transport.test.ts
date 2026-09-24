import {beforeEach,describe,expect,it,vi} from 'vitest';
import {readSourceCover} from '../src/sources/runtime/source-image';
import type {SourceCatalogSnapshot} from '../src/sources/contracts/source';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),permission:vi.fn()}));
vi.mock('../src/sources/runtime/image-fetch',()=>({fetchSourceImage:mocks.fetch}));
vi.mock('../src/sources/runtime/permissions',()=>({requireImagePermissions:mocks.permission}));
const source=():SourceCatalogSnapshot=>({id:'dm5:fixture',sourceId:'dm5',url:'https://www.dm5.com/manhua-fixture/',title:'Fixture',
  observedAt:Date.now(),complete:true,note:'',groups:[],entries:[],cover:{url:'https://mhfm5tel.cdndm5.com/1/98761/cover.jpg'}});
beforeEach(()=>{mocks.fetch.mockReset().mockResolvedValue({blob:new Blob(['cover'])});mocks.permission.mockReset().mockResolvedValue(undefined);});
describe('catalog artwork transport',()=>{
  it('reads authorized cover bytes with the dedicated headers and catalog context',async()=>{
    const snapshot=source(),signal=new AbortController().signal;
    expect(await (await readSourceCover(snapshot,signal)).text()).toBe('cover');
    expect(mocks.permission).toHaveBeenCalledWith([snapshot.cover!.url]);
    expect(mocks.fetch).toHaveBeenCalledWith(snapshot.cover!.url,signal,{referer:'https://www.dm5.com/'},{pageUrl:snapshot.url});
  });
  it('rejects forged catalogs and local/page resources before network access',async()=>{
    for(const snapshot of [{...source(),sourceId:'naver'},{...source(),url:'https://www.dm5.com.evil.test/manhua-fixture/'},
      {...source(),cover:{url:'data:image/png;base64,AAA'}},{...source(),cover:{url:'page-image:fixture'}}])
      await expect(readSourceCover(snapshot)).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();expect(mocks.permission).not.toHaveBeenCalled();
  });
  it('does not read without host permission or after cancellation',async()=>{
    mocks.permission.mockRejectedValueOnce(Error('Permission required'));
    await expect(readSourceCover(source())).rejects.toThrow('Permission required');
    const controller=new AbortController();controller.abort();
    await expect(readSourceCover(source(),controller.signal)).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
