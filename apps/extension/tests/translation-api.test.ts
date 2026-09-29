import {afterEach,describe,it,expect,vi} from 'vitest';
import {Api} from '../src/api';
import {deliveredBytes,deliveredSnapshot} from './overlay-fixture';
afterEach(()=>vi.unstubAllGlobals());
const id='11111111-1111-4111-8111-111111111111',body={image:{sha256:'a'.repeat(64),byte_size:4,content_type:'image/png'},mode:'classic' as const,target_language:'zh-Hans'};
describe('translation resource API',()=>{
 it.each([{body:120,header:'60',expected:120},{body:undefined,header:'75',expected:75}])('honors backpressure $expected',async({body:delay,header,expected})=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'IMAGE_RATE_LIMITED',message:'稍后重试',retry_after_seconds:delay}},{status:429,headers:{'Retry-After':header}})));
  await expect(new Api('https://api.example').translate(id,body)).rejects.toMatchObject({status:429,code:'IMAGE_RATE_LIMITED',retryAfterSeconds:expected});
 });
 it('keeps 304 empty and sends the group ETag without a cursor',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(null,{status:304,headers:{ETag:'"test"'}}));vi.stubGlobal('fetch',fetch);
  expect(await new Api('https://api.example').translations([id],{etag:'"test"'})).toEqual({etag:'"test"',unchanged:true});
  const [url,init]=fetch.mock.calls[0];expect(String(url)).not.toContain('wait_seconds');expect(String(url)).not.toContain('cursor');expect(new Headers(init.headers).get('If-None-Match')).toBe('"test"');
 });
 it('downloads the completed artifact directly with authentication',async()=>{
  const result=deliveredSnapshot(id);
  const fetch=vi.fn().mockResolvedValueOnce(Response.json(result)).mockResolvedValueOnce(new Response(deliveredBytes));vi.stubGlobal('fetch',fetch);vi.stubGlobal('createImageBitmap',async()=>({close(){}}));
  const api=new Api('https://api.example','secret');await api.translate(id,body);await api.translationImage(id);
  expect(fetch).toHaveBeenCalledTimes(2);expect(String(fetch.mock.calls[1][0])).toBe('https://api.example/v1/translations/'+id+'/result');expect(new Headers(fetch.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer secret');
 });
 it('shares the runtime SSE result with the display API without a redundant authorization GET',async()=>{
  const authorization={cacheKey:crypto.randomUUID(),current:async()=>{},token:async()=>'token',reject:async()=>{}},result=deliveredSnapshot(id);
  const fetch=vi.fn().mockResolvedValueOnce(new Response(`event: snapshot\ndata: ${JSON.stringify({items:[result],missing_ids:[]})}\n\nevent: end\ndata: {}\n\n`,{headers:{'Content-Type':'text/event-stream'}})).mockResolvedValueOnce(new Response(deliveredBytes));
  vi.stubGlobal('fetch',fetch);vi.stubGlobal('createImageBitmap',async()=>({close(){}}));
  const runtime=new Api('https://api.example','',undefined,undefined,authorization),display=new Api('https://api.example','',undefined,undefined,authorization);
  for await(const _batch of runtime.translationEvents([id],new AbortController().signal)){/* receive */}
  await display.translationImage(id);expect(fetch).toHaveBeenCalledTimes(2);expect(String(fetch.mock.calls[1][0])).toBe('https://api.example/v1/translations/'+id+'/result');
 });
 it('identifies the protocol on reads, input, result, feedback, SSE and deletion as well as submission',async()=>{
  const received:Headers[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string|URL,init:RequestInit)=>{
   received.push(new Headers(init.headers));
   const path=new URL(url).pathname;
   if(path.endsWith('/events'))return new Response('event: end\ndata: {}\n\n',{headers:{'Content-Type':'text/event-stream'}});
   if(path.endsWith('/result'))return new Response(deliveredBytes);
   if(path==='/v1/translations')return Response.json({items:[deliveredSnapshot(id)],missing_ids:[]});
   if(init.method==='DELETE')return new Response(null,{status:204});
   return Response.json(deliveredSnapshot(id));
  }));
  const api=new Api('https://headers.example','account');
  await api.translate(id,body);await api.translation(id);await api.translations([id]);
  await api.translationInput(id,new Blob(['input']));await api.translationImage(id);
  await api.feedback(id,{issues:['other'],comment:''},crypto.randomUUID());
  for await(const _event of api.translationEvents([id],new AbortController().signal)){/* end */}
  await api.request('/v1/translations/'+id,{method:'DELETE'});
  expect(received).toHaveLength(8);
  expect(received.every(headers=>headers.get('X-Translation-Protocol')==='overlay-v1')).toBe(true);
 });
});
