import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Api} from '../src/api';
import {TranslationResultPrefetch} from '../src/translation/result-prefetch';
import {deliveredBytes,deliveredSnapshot} from './overlay-fixture';

const body={image:{sha256:'a'.repeat(64),byte_size:4,content_type:'image/png'},mode:'classic' as const,target_language:'zh-Hans'};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
beforeEach(()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout']}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
function stalledFetch(signal:AbortSignal){
  return new Promise<Response>((_resolve,reject)=>{signal.throwIfAborted();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
}

describe('translation transport deadlines',()=>{
  it('times out SSE response headers and reconnects the same UUID without submitting',async()=>{
    const id=crypto.randomUUID(),signals:AbortSignal[]=[],fetch=vi.fn(async(_url:unknown,init:RequestInit)=>{
      signals.push(init.signal!);
      if(signals.length===1)return stalledFetch(init.signal!);
      return new Response('event: end\ndata: {}\n\n',{headers:{'Content-Type':'text/event-stream'}});
    });vi.stubGlobal('fetch',fetch);
    const api=new Api('https://sse-timeout.example'),pending=api.translationEvents([id],new AbortController().signal).next();
    const rejected=expect(pending).rejects.toMatchObject({name:'TimeoutError'});
    await flush();await vi.advanceTimersByTimeAsync(30000);await rejected;
    expect(signals[0].aborted).toBe(true);
    expect(await api.translationEvents([id],new AbortController().signal).next()).toMatchObject({done:true});
    expect(fetch.mock.calls.every(([url,init])=>String(url).includes(id)&&!init.method)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the connection deadline once SSE opens and keeps an active heartbeat stream',async()=>{
    let stream!:ReadableStreamDefaultController<Uint8Array>,signal!:AbortSignal;
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
      signal=init.signal;return new Response(new ReadableStream<Uint8Array>({start(value){stream=value;}}),{headers:{'Content-Type':'text/event-stream'}});
    }));
    const pending=new Api('https://sse-heartbeat.example').translationEvents([crypto.randomUUID()],new AbortController().signal).next();
    await flush();
    for(let n=0;n<4;n++){await vi.advanceTimersByTimeAsync(20000);stream.enqueue(new TextEncoder().encode(': heartbeat\n\n'));await flush();}
    expect(signal.aborted).toBe(false);
    stream.enqueue(new TextEncoder().encode('event: end\ndata: {}\n\n'));
    expect(await pending).toMatchObject({done:true});expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['headers','body'] as const)('releases stalled result %s and continues other prefetches without regeneration',async phase=>{
    const ids=[crypto.randomUUID(),crypto.randomUUID()],reads:string[]=[],cancel=vi.fn();let stuck=true;
    const fetch=vi.fn(async(url:string|URL,init:RequestInit)=>{
      const id=ids.find(id=>String(url).includes(id))!;
      if(init.method==='PUT')return Response.json(deliveredSnapshot(id));
      reads.push(id);
      if(id===ids[0]&&stuck)return phase==='headers'?stalledFetch(init.signal!):new Response(new ReadableStream<Uint8Array>({cancel}),{headers:{'Content-Type':'image/webp'}});
      return new Response(deliveredBytes);
    });vi.stubGlobal('fetch',fetch);
    const api=new Api('https://result-timeout.example');for(const id of ids)await api.translate(id,body);
    const prefetch=new TranslationResultPrefetch((id,signal)=>api.translationImage(id,signal));prefetch.update(ids);await flush();
    expect(reads).toEqual([ids[0]]);
    await vi.advanceTimersByTimeAsync(30000);await flush();expect(reads).toEqual(ids);
    if(phase==='body')expect(cancel).toHaveBeenCalledOnce();
    stuck=false;expect(await(await api.translationImage(ids[0])).text()).toBe('image');
    expect(reads).toEqual([...ids,ids[0]]);expect(fetch.mock.calls.filter(([,init])=>init.method==='PUT')).toHaveLength(2);
    prefetch.dispose();expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a result taking longer than 30 seconds while bytes keep arriving',async()=>{
    const id=crypto.randomUUID();let stream!:ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>init.method==='PUT'?Response.json(deliveredSnapshot(id)):
      new Response(new ReadableStream<Uint8Array>({start(value){stream=value;}}),{headers:{'Content-Type':'image/webp'}})));
    const api=new Api('https://result-progress.example');await api.translate(id,body);const pending=api.translationImage(id);await flush();
    for(const byte of new TextEncoder().encode('image')){await vi.advanceTimersByTimeAsync(20000);stream.enqueue(new Uint8Array([byte]));await flush();}
    stream.close();expect(await(await pending).text()).toBe('image');expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a result stream immediately when its consumer leaves',async()=>{
    const id=crypto.randomUUID(),cancel=vi.fn(),controller=new AbortController();
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>init.method==='PUT'?Response.json(deliveredSnapshot(id)):
      new Response(new ReadableStream<Uint8Array>({cancel}))));
    const api=new Api('https://result-cancel.example');await api.translate(id,body);
    const pending=api.translationImage(id,controller.signal),rejected=expect(pending).rejects.toMatchObject({name:'AbortError'});
    await flush();controller.abort();await rejected;expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
});
