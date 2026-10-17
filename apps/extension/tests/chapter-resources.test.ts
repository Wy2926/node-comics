import {describe,expect,it,vi} from 'vitest';
import type {ReadingEntry} from '../src/types';
import {ChapterResourceWindow,type ChapterLoadOptions} from '../src/reader/chapter-resources';

const chapter=(id:string):ReadingEntry=>({id,contentId:id,comicId:'book',title:id,source:'website',sourceKey:id,generation:1,createdAt:0,updatedAt:0,discoveryComplete:true,pageId:id+'-2',relativeOffset:.4,pages:[{id:id+'-2',name:'page',width:800,height:1200,jobs:[],outputBlobs:{}}]});
const deferred=()=>{let resolve!:()=>void,reject!:(reason:unknown)=>void;const promise=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
const loadOptions=expect.objectContaining({signal:expect.any(AbortSignal),speculative:false});

describe('reading window resource renewal',()=>{
 it('keeps the opened chapter ready and gates an already indexed neighbour until renewal finishes',async()=>{
  const current=chapter('current'),next=chapter('next'),original=structuredClone(next),pending=deferred(),load=vi.fn(()=>pending.promise),changed=vi.fn(),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,changed);window.prepare([current,next],load,changed);
  expect(window.ready(current)).toBe(true);expect(window.ready(next)).toBe(false);expect(next).toEqual(original);
  await vi.waitFor(()=>expect(load).toHaveBeenCalledExactlyOnceWith('next',loadOptions));
  pending.resolve();await vi.waitFor(()=>expect(window.ready(next)).toBe(true));
  expect(changed).toHaveBeenCalledTimes(1);expect(next.pageId).toBe('next-2');expect(next.relativeOffset).toBe(.4);
  window.prepare([current,next],load,changed);expect(load).toHaveBeenCalledTimes(1);
 });
 it('renews a returning chapter and ignores the earlier request that outlived its window',async()=>{
  const current=chapter('current'),next=chapter('next'),old=deferred(),fresh=deferred(),load=vi.fn<(id:string,options?:ChapterLoadOptions)=>Promise<void>>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),changed=vi.fn(),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,changed);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
  window.prepare([current],load,changed);window.prepare([current,next],load,changed);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
  expect(load.mock.calls[0][1]?.signal?.aborted).toBe(true);expect(load.mock.calls[1][1]?.signal?.aborted).toBe(false);
  old.resolve();await old.promise;await Promise.resolve();await Promise.resolve();expect(window.ready(next)).toBe(false);expect(changed).not.toHaveBeenCalled();
  fresh.resolve();await vi.waitFor(()=>expect(window.ready(next)).toBe(true));expect(changed).toHaveBeenCalledTimes(1);
 });
 it('never loads an unresolved candidate outside the chosen sequence and releases cached pages after a reported failure',async()=>{
  const current=chapter('current'),next=chapter('selected'),candidate=chapter('unselected'),load=vi.fn().mockRejectedValue(Error('source unavailable')),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,()=>{});await vi.waitFor(()=>expect(window.ready(next)).toBe(true));
  expect(load).toHaveBeenCalledExactlyOnceWith('selected',loadOptions);expect(window.ready(candidate)).toBe(false);expect(next.pages).toHaveLength(1);
 });
 it('invalidates readiness for a changed content identity and drops late completion on unmount',async()=>{
  const current=chapter('current'),next=chapter('next'),pending=deferred(),changed=vi.fn(),window=new ChapterResourceWindow(current),load=vi.fn((_id:string,_options?:ChapterLoadOptions)=>pending.promise);
  expect(window.ready({...current,contentId:'new-content'})).toBe(false);
  expect(window.ready({...current,generation:2})).toBe(false);
  window.prepare([current,next],load,changed);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));window.clear();pending.resolve();
  expect(load.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await pending.promise;await Promise.resolve();await Promise.resolve();expect(window.ready(next)).toBe(false);expect(changed).not.toHaveBeenCalled();
 });
 it('does not start a removed request in its queued microtask',async()=>{
  const current=chapter('current'),next=chapter('next'),load=vi.fn(),changed=vi.fn(),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,changed,['next']);window.prepare([current],load,changed);
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(load).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();expect(window.ready(next)).toBe(false);
 });
 it('does not start a request after synchronous clear',async()=>{
  const current=chapter('current'),next=chapter('next'),load=vi.fn(),changed=vi.fn(),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,changed,['next']);window.clear();
  await Promise.resolve();await Promise.resolve();await Promise.resolve();
  expect(load).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
 });
 it('cancels only a removed neighbour while preserving the current in-flight preparation',async()=>{
  const current={...chapter('current'),pages:[]},next=chapter('next'),foreground=deferred(),background=deferred(),changed=vi.fn(),window=new ChapterResourceWindow(current);
  const load=vi.fn((id:string,_options?:ChapterLoadOptions)=>id==='current'?foreground.promise:background.promise);
  window.prepare([current,next],load,changed,['next']);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
  window.prepare([current],load,changed);
  expect(load.mock.calls[0][1]?.signal?.aborted).toBe(false);expect(load.mock.calls[1][1]?.signal?.aborted).toBe(true);
  background.resolve();foreground.resolve();await vi.waitFor(()=>expect(window.ready(current)).toBe(true));
  expect(window.ready(next)).toBe(false);expect(changed).toHaveBeenCalledTimes(1);
 });
 it('retries a failed background preparation once when the chapter becomes foreground and keeps cached pages ready',async()=>{
  const current=chapter('current'),next=chapter('next'),retry=deferred(),changed=vi.fn(),window=new ChapterResourceWindow(current);
  const load=vi.fn<(id:string,options?:ChapterLoadOptions)=>Promise<void>>().mockRejectedValueOnce(Error('background unavailable')).mockReturnValueOnce(retry.promise);
  window.prepare([current,next],load,changed,['next']);await vi.waitFor(()=>expect(window.ready(next)).toBe(true));
  expect(load).toHaveBeenCalledExactlyOnceWith('next',expect.objectContaining({speculative:true}));
  window.prepare([current,next],load,changed,['next']);expect(load).toHaveBeenCalledTimes(1);
  window.prepare([next],load,changed);expect(window.ready(next)).toBe(true);
  await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(2));expect(load.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(load.mock.calls[1][1]?.speculative).toBe(false);
  retry.reject(Error('foreground unavailable'));await vi.waitFor(()=>expect(changed).toHaveBeenCalledTimes(2));
  window.prepare([next],load,changed);window.prepare([next],load,changed);
  expect(load).toHaveBeenCalledTimes(2);expect(window.ready(next)).toBe(true);
 });
 it('does not mistake an obsolete background loader rejection for successful preparation',async()=>{
  const current=chapter('current'),next={...chapter('next'),pages:[]},changed=vi.fn(),window=new ChapterResourceWindow(current);
  const load=vi.fn<(id:string,options?:ChapterLoadOptions)=>Promise<void>>().mockRejectedValueOnce(new DOMException('Reading context changed','AbortError')).mockResolvedValueOnce();
  window.prepare([current,next],load,changed,['next']);await vi.waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));
  window.prepare([next],load,changed);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
  expect(load.mock.calls[1][1]?.speculative).toBe(false);
  await vi.waitFor(()=>expect(changed).toHaveBeenCalledTimes(2));window.prepare([next],load,changed);expect(load).toHaveBeenCalledTimes(2);
 });
 it('promotes an in-flight background request through live options without starting a duplicate',async()=>{
  const current=chapter('current'),next=chapter('next'),pending=deferred(),changed=vi.fn(),window=new ChapterResourceWindow(current);
  const load=vi.fn((_id:string,_options?:ChapterLoadOptions)=>pending.promise);
  window.prepare([current,next],load,changed,['next']);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
  const options=load.mock.calls[0][1]!;expect(options.speculative).toBe(true);
  window.prepare([next],load,changed);expect(options.speculative).toBe(false);expect(options.signal?.aborted).toBe(false);
  pending.reject(Error('foreground failure'));await vi.waitFor(()=>expect(window.ready(next)).toBe(true));
  window.prepare([next],load,changed);expect(load).toHaveBeenCalledTimes(1);expect(changed).toHaveBeenCalledTimes(1);
 });
 it('uses the latest foreground status before a queued request starts',async()=>{
  const current=chapter('current'),next=chapter('next'),load=vi.fn(),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,()=>{},['next']);window.prepare([next],load,()=>{});
  await vi.waitFor(()=>expect(load).toHaveBeenCalledExactlyOnceWith('next',loadOptions));
 });
 it('reuses a successful background preparation when it becomes the active chapter',async()=>{
  const current=chapter('current'),next=chapter('next'),load=vi.fn(),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,()=>{},['next']);await vi.waitFor(()=>expect(window.ready(next)).toBe(true));
  window.prepare([next],load,()=>{});expect(window.ready(next)).toBe(true);expect(load).toHaveBeenCalledTimes(1);
 });
 it('aborts an obsolete content generation before preparing its replacement',async()=>{
  const current=chapter('current'),next=chapter('next'),replacement={...next,generation:2},old=deferred(),fresh=deferred(),changed=vi.fn(),window=new ChapterResourceWindow(current);
  const load=vi.fn<(id:string,options?:ChapterLoadOptions)=>Promise<void>>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  window.prepare([current,next],load,changed,['next']);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
  window.prepare([current,replacement],load,changed,['next']);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
  expect(load.mock.calls[0][1]?.signal?.aborted).toBe(true);expect(window.ready(next)).toBe(false);expect(window.ready(replacement)).toBe(false);
  old.resolve();fresh.resolve();await vi.waitFor(()=>expect(window.ready(replacement)).toBe(true));expect(changed).toHaveBeenCalledTimes(1);
 });
});
