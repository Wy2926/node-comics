import {describe,expect,it,vi} from 'vitest';
import type {ReadingEntry} from '../src/types';
import {ChapterResourceWindow} from '../src/reader/chapter-resources';

const chapter=(id:string):ReadingEntry=>({id,contentId:id,comicId:'book',title:id,source:'website',sourceKey:id,generation:1,createdAt:0,updatedAt:0,discoveryComplete:true,pageId:id+'-2',relativeOffset:.4,pages:[{id:id+'-2',name:'page',width:800,height:1200,jobs:[],outputBlobs:{}}]});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

describe('reading window resource renewal',()=>{
 it('keeps the opened chapter ready and gates an already indexed neighbour until renewal finishes',async()=>{
  const current=chapter('current'),next=chapter('next'),original=structuredClone(next),pending=deferred(),load=vi.fn(()=>pending.promise),changed=vi.fn(),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,changed);window.prepare([current,next],load,changed);
  expect(window.ready(current)).toBe(true);expect(window.ready(next)).toBe(false);expect(next).toEqual(original);
  await vi.waitFor(()=>expect(load).toHaveBeenCalledExactlyOnceWith('next'));
  pending.resolve();await vi.waitFor(()=>expect(window.ready(next)).toBe(true));
  expect(changed).toHaveBeenCalledTimes(1);expect(next.pageId).toBe('next-2');expect(next.relativeOffset).toBe(.4);
  window.prepare([current,next],load,changed);expect(load).toHaveBeenCalledTimes(1);
 });
 it('renews a returning chapter and ignores the earlier request that outlived its window',async()=>{
  const current=chapter('current'),next=chapter('next'),old=deferred(),fresh=deferred(),load=vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),changed=vi.fn(),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,changed);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
  window.prepare([current],load,changed);window.prepare([current,next],load,changed);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
  old.resolve();await old.promise;await Promise.resolve();await Promise.resolve();expect(window.ready(next)).toBe(false);expect(changed).not.toHaveBeenCalled();
  fresh.resolve();await vi.waitFor(()=>expect(window.ready(next)).toBe(true));expect(changed).toHaveBeenCalledTimes(1);
 });
 it('never loads an unresolved candidate outside the chosen sequence and releases cached pages after a reported failure',async()=>{
  const current=chapter('current'),next=chapter('selected'),candidate=chapter('unselected'),load=vi.fn().mockRejectedValue(Error('source unavailable')),window=new ChapterResourceWindow(current);
  window.prepare([current,next],load,()=>{});await vi.waitFor(()=>expect(window.ready(next)).toBe(true));
  expect(load).toHaveBeenCalledExactlyOnceWith('selected');expect(window.ready(candidate)).toBe(false);expect(next.pages).toHaveLength(1);
 });
 it('invalidates readiness for a changed content identity and drops late completion on unmount',async()=>{
  const current=chapter('current'),next=chapter('next'),pending=deferred(),changed=vi.fn(),window=new ChapterResourceWindow(current),load=vi.fn(()=>pending.promise);
  expect(window.ready({...current,contentId:'new-content'})).toBe(false);
  window.prepare([current,next],load,changed);await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));window.clear();pending.resolve();
  await pending.promise;await Promise.resolve();await Promise.resolve();expect(window.ready(next)).toBe(false);expect(changed).not.toHaveBeenCalled();
 });
});
