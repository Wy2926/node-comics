import 'fake-indexeddb/auto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {Api} from '../src/api';
import {serverEvents} from '../src/sse';
import {fixture,target,snapshot} from './translation-fixture';
const id='11111111-1111-4111-8111-111111111111';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('translation SSE',()=>{
  it('decodes split UTF-8, CRLF, multiline data and ignores heartbeats',async()=>{
    const bytes=new TextEncoder().encode(': ping\r\nevent: snapshot\r\ndata: {"value":\r\ndata: "完成"}\r\n\r\n');
    const stream=new ReadableStream<Uint8Array>({start(c){for(const byte of bytes)c.enqueue(new Uint8Array([byte]));c.close();}});
    const values=[];for await(const value of serverEvents(stream,new AbortController().signal))values.push(value);
    expect(values).toEqual([{event:'snapshot',data:'{"value":\n"完成"}'}]);
  });
  it('uses one authenticated HTTP response for several updates and cancels on abort',async()=>{
    let send!:ReadableStreamDefaultController<Uint8Array>;const cancel=vi.fn();
    const fetch=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){send=c;},cancel}),{headers:{'Content-Type':'text/event-stream'}}));vi.stubGlobal('fetch',fetch);
    const api=new Api('https://events.example','secret'),controller=new AbortController(),events=api.translationEvents([id],controller.signal);
    const pending=events.next();await vi.waitFor(()=>expect(send).toBeDefined());
    const emit=(state:string)=>send.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({items:[{id,state}],missing_ids:[]})}\n\n`));
    emit('queued');expect((await pending).value?.items[0].state).toBe('queued');
    emit('running');expect((await events.next()).value?.items[0].state).toBe('running');
    expect(fetch).toHaveBeenCalledOnce();const [url,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).not.toContain('secret');expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
    const waiting=events.next();controller.abort();await expect(waiting).rejects.toThrow();expect(cancel).toHaveBeenCalledOnce();
  });
  it('treats premature EOF and HTTP backpressure as failures, not an immediate retry loop',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(': ping\n\n',{headers:{'Content-Type':'text/event-stream'}})).mockResolvedValueOnce(Response.json({error:{code:'WAIT_BUSY',message:'wait'}},{status:429,headers:{'Retry-After':'17'}})));
    const api=new Api('https://events.example');
    await expect(api.translationEvents([id],new AbortController().signal).next()).rejects.toMatchObject({code:'EVENT_STREAM_CLOSED'});
    await expect(api.translationEvents([id],new AbortController().signal).next()).rejects.toMatchObject({status:429,retryAfterSeconds:17});
  });
  it('releases an unresponsive stream when heartbeats stop',async()=>{
    const cancel=vi.fn(),stream=new ReadableStream<Uint8Array>({cancel});
    await expect(serverEvents(stream,new AbortController().signal,10).next()).rejects.toThrow('idle');expect(cancel).toHaveBeenCalledOnce();
  });
  it('keeps one subscription when pages finish, closes on terminal state, and does no recovery GET',async()=>{
    const f=fixture(),signal=new AbortController().signal;await f.core.submit([target(0),target(1)]);
    const items=f.submit.mock.calls.map(([key,body])=>snapshot(key,body));const finished=vi.fn();
    vi.mocked(f.api.translationEvents).mockImplementation(async function*(){try{yield {items:[{...items[0],state:'succeeded',result:{kind:'no_text',representation:'original',normalization_version:1,input_sha256:'a'.repeat(64),width:800,height:1200}},items[1]],missing_ids:[]};yield {items:items.map(item=>({...item,state:'succeeded' as const,result:{kind:'no_text' as const,representation:'original' as const,normalization_version:1 as const,input_sha256:'a'.repeat(64),width:800,height:1200}})),missing_ids:[]};}finally{finished();}});
    await f.core.wait(signal);expect(f.core.waitingIds).toEqual([items[1].id]);
    await f.core.wait(signal);expect(f.core.hasPending).toBe(false);await f.core.wait(signal);
    expect(f.api.translationEvents).toHaveBeenCalledOnce();expect(f.api.translations).not.toHaveBeenCalled();await vi.waitFor(()=>expect(finished).toHaveBeenCalledOnce());
  });
  it('reconnects the same durable UUIDs after a stream failure without new PUTs',async()=>{
    const f=fixture();await f.core.submit([target(0)]);const [key,body]=f.submit.mock.calls[0];
    vi.mocked(f.api.translationEvents).mockImplementationOnce(async function*(){throw Error('disconnected');}).mockImplementationOnce(async function*(){yield {items:[snapshot(key,body,{state:'succeeded',result:{kind:'no_text',representation:'original',normalization_version:1,input_sha256:'a'.repeat(64),width:800,height:1200}})],missing_ids:[]};});
    const signal=new AbortController().signal;await expect(f.core.wait(signal)).rejects.toThrow('disconnected');await f.core.wait(signal);
    expect(f.api.translationEvents).toHaveBeenNthCalledWith(2,[key],expect.any(AbortSignal));expect(f.submit).toHaveBeenCalledOnce();expect(f.core.hasPending).toBe(false);
  });
});
