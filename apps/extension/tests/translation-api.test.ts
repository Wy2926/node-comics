import {afterEach,describe,it,expect,vi} from 'vitest';
import {Api} from '../src/api';
afterEach(()=>vi.unstubAllGlobals());
const id='11111111-1111-4111-8111-111111111111',body={image:{sha256:'a'.repeat(64),byte_size:4,content_type:'image/png'},mode:'classic' as const,target_language:'zh-Hans'};
describe('translation resource API',()=>{
 it.each([{body:120,header:'60',expected:120},{body:undefined,header:'75',expected:75}])('honors backpressure $expected',async({body:delay,header,expected})=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'IMAGE_RATE_LIMITED',message:'稍后重试',retry_after_seconds:delay}},{status:429,headers:{'Retry-After':header}})));
  await expect(new Api('https://api.example').translate(id,body)).rejects.toMatchObject({status:429,code:'IMAGE_RATE_LIMITED',retryAfterSeconds:expected});
 });
 it('keeps 304 empty and sends the group ETag without a cursor',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(null,{status:304,headers:{ETag:'"test"'}}));vi.stubGlobal('fetch',fetch);
  expect(await new Api('https://api.example').translations([id],{etag:'"test"',wait:true})).toEqual({etag:'"test"',unchanged:true});
  const [url,init]=fetch.mock.calls[0];expect(String(url)).toContain('wait_seconds=20');expect(String(url)).not.toContain('cursor');expect(new Headers(init.headers).get('If-None-Match')).toBe('"test"');
 });
 it('downloads the completed response directly, refreshing only an expired signature',async()=>{
  const result={id,state:'succeeded',mode:'classic',target_language:'zh-Hans',result:{kind:'translated',asset_id:'asset',download_url:'https://objects.example/image',download_expires_at:'2099-01-01',authorization_required:false}};
  const fetch=vi.fn().mockResolvedValueOnce(Response.json(result)).mockResolvedValueOnce(new Response(new Blob(['image'])));vi.stubGlobal('fetch',fetch);vi.stubGlobal('createImageBitmap',async()=>({close(){}}));
  const api=new Api('https://api.example','secret');await api.translate(id,body);await api.translationImage(id);
  expect(fetch).toHaveBeenCalledTimes(2);expect(String(fetch.mock.calls[1][0])).toBe('https://objects.example/image');expect(new Headers(fetch.mock.calls[1][1].headers).has('Authorization')).toBe(false);
 });
});
