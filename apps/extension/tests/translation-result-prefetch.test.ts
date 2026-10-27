import {describe,expect,it,vi} from 'vitest';
import {TranslationResultPrefetch} from '../src/translation/result-prefetch';

const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

describe('translation result prefetch',()=>{
  it('warms at most five unique results serially and keeps overlapping work',async()=>{
    const first=Promise.withResolvers<Blob>(),read=vi.fn(async(_key:string,_signal?:AbortSignal)=>new Blob(['result']));
    read.mockImplementationOnce(()=>first.promise);
    const prefetch=new TranslationResultPrefetch(read);
    prefetch.update(['a','a','b','c','d','e','f']);await flush();
    expect(read.mock.calls.map(([key])=>key)).toEqual(['a']);
    prefetch.update(['a','b','c','d','e']);
    first.resolve(new Blob(['a']));await flush();
    expect(read.mock.calls.map(([key])=>key)).toEqual(['a','b','c','d','e']);
    prefetch.update(['b','c','d','e','f']);await flush();
    expect(read.mock.calls.map(([key])=>key)).toEqual(['a','b','c','d','e','f']);
    prefetch.dispose();
  });

  it('isolates a failed download and attempts it only once while it stays in the window',async()=>{
    const read=vi.fn(async(_key:string,_signal?:AbortSignal)=>new Blob(['result']));read.mockRejectedValueOnce(Error('offline'));
    const prefetch=new TranslationResultPrefetch(read);
    prefetch.update(['a','b']);await flush();prefetch.update(['a','b']);await flush();
    expect(read.mock.calls.map(([key])=>key)).toEqual(['a','b']);
    prefetch.update(['b']);prefetch.update(['b','a']);await flush();
    expect(read.mock.calls.map(([key])=>key)).toEqual(['a','b','a']);
    prefetch.dispose();
  });

  it('starts the latest window even if an obsolete reader has not settled after cancellation',async()=>{
    const first=Promise.withResolvers<Blob>(),read=vi.fn(async(_key:string,_signal?:AbortSignal)=>new Blob(['result']));
    read.mockImplementationOnce(()=>first.promise);
    const prefetch=new TranslationResultPrefetch(read);
    prefetch.update(['a','b']);prefetch.update(['c','d']);
    expect(read.mock.calls[0][1]?.aborted).toBe(true);expect(read).toHaveBeenCalledOnce();
    await flush();
    expect(read.mock.calls.map(([key])=>key)).toEqual(['a','c','d']);
    first.reject(new DOMException('Aborted','AbortError'));await flush();
    expect(read).toHaveBeenCalledTimes(3);
    prefetch.dispose();
  });

  it('cancels and discards queued work on disposal, and can resume the cancelled result',async()=>{
    const first=Promise.withResolvers<Blob>(),read=vi.fn(async(_key:string,_signal?:AbortSignal)=>new Blob(['result']));
    read.mockImplementationOnce(()=>first.promise);
    const prefetch=new TranslationResultPrefetch(read);
    prefetch.update(['a','b']);prefetch.dispose();
    expect(read.mock.calls[0][1]?.aborted).toBe(true);
    first.resolve(new Blob(['late']));await flush();expect(read).toHaveBeenCalledOnce();
    prefetch.update(['a']);await flush();expect(read.mock.calls.map(([key])=>key)).toEqual(['a','a']);
    prefetch.dispose();
  });
});
