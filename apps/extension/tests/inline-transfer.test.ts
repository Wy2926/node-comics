import {createHash} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {IMAGE_CHUNK_BYTES, receiveImage, serveImage} from '../src/inline/blob-transfer';

function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return {addListener: (fn: (...args: any[]) => void) => listeners.add(fn), removeListener: (fn: (...args: any[]) => void) => listeners.delete(fn),
    emit: (...args: any[]) => {for (const fn of [...listeners]) fn(...args);}, get size() {return listeners.size;}};
}
function pair() {
  let closed = false;
  const make = () => ({name: 'fixture', onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn()});
  const client = make(), server = make();
  for (const [a,b] of [[client,server],[server,client]]) {
    a.postMessage.mockImplementation(value => {
      if (closed) throw Error('Port closed');
      // Chrome serializes messages; queued sends precede queued disconnection.
      const copy = JSON.parse(JSON.stringify(value)); queueMicrotask(() => b.onMessage.emit(copy));
    });
    a.disconnect.mockImplementation(() => {if (!closed) {closed = true;queueMicrotask(() => {a.onDisconnect.emit();b.onDisconnect.emit();});}});
  }
  return {client,server,port:client as unknown as chrome.runtime.Port,remote:server as unknown as chrome.runtime.Port};
}
const digest = async (blob: Blob) => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
beforeEach(() => vi.stubGlobal('chrome', {runtime: {}}));
afterEach(() => {vi.useRealTimers();vi.unstubAllGlobals();});

describe('bounded inline image ports', () => {
  it('round-trips an image above the old Base64 message ceiling with exact bytes and bounded messages', async () => {
    const p = pair(), source = new Blob([new Uint8Array(49 * 1024 * 1024).fill(137), new Uint8Array([1,2,255])], {type:'image/png'});
    const load = vi.fn(async (_request:unknown) => ({blob:source,current:()=>true})), closed = vi.fn();
    serveImage(p.remote,load,closed);
    const result = await receiveImage(p.port,{id:'bound-to-page'});
    expect(result.size).toBe(source.size);expect(result.type).toBe(source.type);expect(await digest(result)).toBe(await digest(source));
    expect(load).toHaveBeenCalledOnce();expect(load.mock.calls[0][0]).toEqual({id:'bound-to-page'});
    const chunks = p.server.postMessage.mock.calls.map(([value]) => value).filter(value => value.type === 'chunk');
    expect(chunks).toHaveLength(Math.ceil(source.size / IMAGE_CHUNK_BYTES));
    expect(Math.max(...chunks.map(value => JSON.stringify(value).length))).toBeLessThan(710_000);
    expect(closed).toHaveBeenCalledOnce();expect(p.client.onMessage.size + p.server.onMessage.size).toBe(0);
  });
  it('does not read ahead of the receiver and aborts unfinished loading on disconnect', async () => {
    const p = pair(), source = new Blob([new Uint8Array(IMAGE_CHUNK_BYTES * 3)]), slice = vi.spyOn(source,'slice');
    let signal: AbortSignal | undefined;
    serveImage(p.remote,async (_request,s) => {signal=s;return {blob:source,current:()=>true};});
    p.client.postMessage({type:'open',request:{}});await vi.waitFor(() => expect(p.server.postMessage).toHaveBeenCalled());
    expect(slice).not.toHaveBeenCalled();p.client.postMessage({type:'pull',offset:0});
    await vi.waitFor(() => expect(p.server.postMessage.mock.calls.filter(([v]) => v.type==='chunk')).toHaveLength(1));
    expect(slice).toHaveBeenCalledOnce();p.client.disconnect();await Promise.resolve();expect(signal?.aborted).toBe(true);
  });
  it('cancels a pending load, discards late bytes and releases listeners', async () => {
    const p = pair(), abort = new AbortController();let done!: (value: {blob:Blob;current:()=>boolean})=>void;
    const closed = vi.fn();serveImage(p.remote,() => new Promise(resolve => {done=resolve;}),closed);
    const result = receiveImage(p.port,{},abort.signal);const rejected = expect(result).rejects.toMatchObject({name:'AbortError'});
    await Promise.resolve();abort.abort();await rejected;
    done({blob:new Blob(['late']),current:()=>true});await Promise.resolve();
    expect(p.server.postMessage).not.toHaveBeenCalled();expect(closed).toHaveBeenCalledOnce();
  });
  it('preserves a delivery error without submitting or converting it to retranslation', async () => {
    const p = pair();serveImage(p.remote,async () => {throw Object.assign(Error('cache gone'),{code:'RESULT_NOT_CACHED'});});
    await expect(receiveImage(p.port,{})).rejects.toMatchObject({message:'cache gone',code:'RESULT_NOT_CACHED'});
  });
  it.each(['offset','length','oversize','metadata'])('rejects malformed %s responses', async kind => {
    const p = pair();
    p.server.onMessage.addListener(value => {
      if(value.type==='open')p.server.postMessage({type:'image',size:kind==='metadata'?-1:1,mime:'image/png'});
      if(value.type==='pull')p.server.postMessage({type:'chunk',offset:kind==='offset'?1:0,data:kind==='oversize'?'A'.repeat(710000):kind==='length'?'AAAA':'AA=='});
    });
    await expect(receiveImage(p.port,{})).rejects.toMatchObject({code:'IMAGE_TRANSFER_FAILED'});
  });
  it('rechecks result identity before reading a slice', async () => {
    const p = pair();let current = true;
    serveImage(p.remote,async () => ({blob:new Blob(['image']),current:()=>current}));
    p.server.onMessage.addListener(value=>{if(value.type==='open')current=false;});
    await expect(receiveImage(p.port,{})).rejects.toMatchObject({code:'IMAGE_TRANSFER_FAILED'});
  });
  it('bounds stalled preparation even while keeping the service worker alive', async () => {
    vi.useFakeTimers();const p=pair();serveImage(p.remote,()=>new Promise(()=>{}));
    const result=receiveImage(p.port,{}),rejected=expect(result).rejects.toMatchObject({code:'IMAGE_TRANSFER_FAILED'});
    await vi.advanceTimersByTimeAsync(120001);await rejected;
    expect(p.client.postMessage.mock.calls.some(([v])=>v.type==='ping')).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });
});
