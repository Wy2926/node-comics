import {afterEach,describe,expect,it,vi} from 'vitest';
import {Api,ApiError} from '../src/api';
import {resolveComicTitle} from '../src/comics/application/search/title-resolver';

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('comic title API client',()=>{
  it('posts only the trimmed name and requested title language with the existing authorization and signal',async()=>{
    const fetch=vi.fn().mockResolvedValue(Response.json({name:'星光书店',target_language:'zh-Hans'}));vi.stubGlobal('fetch',fetch);
    const controller=new AbortController();await new Api('https://api.example/','token').translateComicTitle(' 星あかりの本屋 ','zh-Hans',controller.signal);
    const [url,init]=fetch.mock.calls[0];expect(url).toBe('https://api.example/v1/comic-titles/translate');expect(JSON.parse(init.body)).toEqual({name:'星あかりの本屋',target_language:'zh-Hans'});expect(init.signal).toBe(controller.signal);expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token');
  });
  it('counts input code points rather than UTF-16 and does not apply the input limit to responses',async()=>{
    const fetch=vi.fn().mockResolvedValue(Response.json({name:'a'.repeat(90),target_language:'en'}));vi.stubGlobal('fetch',fetch);const api=new Api('https://api.example');
    await expect(api.translateComicTitle('𠮷'.repeat(60),'en')).resolves.toMatchObject({name:'a'.repeat(90)});
    await expect(api.translateComicTitle('𠮷'.repeat(61),'en')).rejects.toMatchObject({status:422});await expect(api.translateComicTitle('a\u0000b','en')).rejects.toMatchObject({status:422});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts null but rejects incomplete or malformed responses',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(Response.json({name:null,target_language:null})).mockResolvedValueOnce(Response.json({name:'Name',target_language:null}));vi.stubGlobal('fetch',fetch);const api=new Api('https://api.example');
    await expect(api.translateComicTitle('Name','en')).resolves.toEqual({name:null,target_language:null});await expect(api.translateComicTitle('Name','en')).rejects.toMatchObject({code:'INVALID_COMIC_TITLE_RESPONSE'});
  });
  it('preserves Retry-After on API errors',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({detail:{code:'COMIC_TITLE_BUSY',message:'busy'}},{status:503,headers:{'Retry-After':'3'}})));
    await expect(new Api('https://api.example').translateComicTitle('Name','en')).rejects.toMatchObject({code:'COMIC_TITLE_BUSY',retryAfterSeconds:3,status:503});
  });
  it('retries busy/pending once according to Retry-After and aborts the wait without another call',async()=>{
    vi.useFakeTimers();const controller=new AbortController(),run=vi.fn().mockRejectedValueOnce(new ApiError('Busy','COMIC_TITLE_BUSY',503,undefined,2)).mockResolvedValue({name:'Name',target_language:'en'});
    const response=resolveComicTitle(run,controller.signal);await vi.advanceTimersByTimeAsync(1_999);expect(run).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);await expect(response).resolves.toMatchObject({name:'Name'});expect(run).toHaveBeenCalledTimes(2);
    const stop=new AbortController(),pending=vi.fn().mockRejectedValue(new ApiError('Pending','COMIC_TITLE_PENDING',503,undefined,3));const aborted=resolveComicTitle(pending,stop.signal);const outcome=expect(aborted).rejects.toMatchObject({name:'AbortError'});await vi.advanceTimersByTimeAsync(1);stop.abort();await outcome;await vi.advanceTimersByTimeAsync(5_000);expect(pending).toHaveBeenCalledTimes(1);
  });
});
