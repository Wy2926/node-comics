import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {InlineImage,InlineResponse} from '../inline/protocol';
import type {SessionReaderWindow} from '../reader/session-model';
import {ImmersiveTranslation} from './translation';

const images:InlineImage[]=Array.from({length:5},(_,i)=>({id:`page-${i}`,url:`page-image:page-${i}`,width:800,height:1200}));
const view=(mode:SessionReaderWindow['view']='translation'):SessionReaderWindow=>({pageIds:images.map(image=>image.id),visiblePageIds:['page-0'],view:mode,immediate:true});
const response=(revision=1):InlineResponse=>({contextId:'context',scope:'scope',revision,mode:'classic',language:'zh-Hans',items:[],hasPending:false});
const sendMessage=vi.fn();
let clients:ImmersiveTranslation[];
let visibility:{hidden:boolean};
const client=()=>{const changed=vi.fn(),value=new ImmersiveTranslation('navigation',changed);clients.push(value);return {value,changed};};
const messages=(type:string)=>sendMessage.mock.calls.map(([message])=>message).filter(message=>message.type===type);

beforeEach(()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});
  sendMessage.mockReset().mockResolvedValue({ok:true,data:response()});clients=[];
  visibility={hidden:false};vi.stubGlobal('document',visibility);
  vi.stubGlobal('navigator',{onLine:true});
  vi.stubGlobal('chrome',{runtime:{sendMessage,connect:vi.fn()}});
});
afterEach(()=>{
  for(const value of clients)value.dispose();
  vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();
});

describe('immersive translation view client',()=>{
  it.each([false,true])('leaves no scheduled work for an empty translation window (previously active: %s)',async started=>{
    const {value}=client();
    if(started)value.update(view(),images);
    const empty={...view(),pageIds:[],visiblePageIds:[]};
    value.update(empty,[]);
    expect(vi.getTimerCount()).toBe(0);
    value.reset();value.update(empty,[]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(messages('NC_INLINE_TICK')).toEqual([]);
    expect(messages('NC_INLINE_WAIT')).toEqual([]);
    expect(messages('NC_INLINE_INVALIDATE').at(-1).keepIds).toEqual([]);
    value.update(view(),images);
    await vi.advanceTimersByTimeAsync(150);
    expect(messages('NC_INLINE_TICK')).toHaveLength(1);
  });

  it('does not submit, read results, or start a channel while displaying original images',async()=>{
    const {value}=client();
    value.update(view('original'),images);
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages('NC_INLINE_TICK')).toEqual([]);
    expect(messages('NC_INLINE_WAIT')).toEqual([]);
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    expect(await value.read(images[0],new AbortController().signal)).toBeUndefined();
  });

  it('keeps generation increasing when the view controller is recreated in the same document',async()=>{
    const first=client().value;
    first.update(view(),images);
    await vi.advanceTimersByTimeAsync(150);
    const firstGeneration=messages('NC_INLINE_TICK').at(-1).generation;
    first.dispose();
    const disposedGeneration=messages('NC_INLINE_INVALIDATE').at(-1).generation;
    const next=client().value;
    next.update(view(),images);
    await vi.advanceTimersByTimeAsync(150);
    const nextGeneration=messages('NC_INLINE_TICK').at(-1).generation;
    expect(disposedGeneration).toBeGreaterThan(firstGeneration);
    expect(nextGeneration).toBeGreaterThan(disposedGeneration);
    const all=messages('NC_INLINE_TICK');
    expect(all.every(message=>message.images.length<=5&&message.readingImages.length<=5)).toBe(true);
  });

  it('clears the reading window while hidden, ignores stale results, and resumes with a fresh generation',async()=>{
    const {value,changed}=client();
    value.update(view(),images);
    await vi.advanceTimersByTimeAsync(150);
    const shownGeneration=messages('NC_INLINE_TICK').at(-1).generation;
    const tickCount=messages('NC_INLINE_TICK').length;
    const changedCount=changed.mock.calls.length;
    visibility.hidden=true;
    value.update(view(),images);
    const hidden=messages('NC_INLINE_INVALIDATE').at(-1);
    expect(hidden.keepIds).toEqual([]);
    expect(hidden.generation).toBeGreaterThan(shownGeneration);
    value.onMessage({type:'NC_INLINE_UPDATE',navigationId:'navigation',generation:shownGeneration,
      data:{...response(2),items:[{id:'page-0',resultKey:'stale-result'}]}});
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages('NC_INLINE_TICK')).toHaveLength(tickCount);
    expect(value.results.size).toBe(0);
    expect(changed).toHaveBeenCalledTimes(changedCount);
    visibility.hidden=false;
    value.update(view(),images);
    await vi.advanceTimersByTimeAsync(150);
    expect(messages('NC_INLINE_TICK').at(-1).generation).toBeGreaterThan(hidden.generation);
  });

  it('does not reset the generation or submit again for status-only updates to the same reading window',async()=>{
    const {value}=client();
    value.update(view(),images);
    await vi.advanceTimersByTimeAsync(150);
    const before=sendMessage.mock.calls.length;
    value.update({...view(),pageIds:[...view().pageIds]},images.map(image=>({...image})));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessage).toHaveBeenCalledTimes(before);
  });

  it('fences an in-flight submission when changing back to original view',async()=>{
    const pending=Promise.withResolvers<{ok:boolean;data:InlineResponse}>();
    sendMessage.mockImplementation(async message=>message.type==='NC_INLINE_TICK'?pending.promise:{ok:true,data:response()});
    const {value,changed}=client();
    value.update(view(),images);
    await vi.advanceTimersByTimeAsync(150);
    expect(messages('NC_INLINE_TICK')).toHaveLength(1);
    value.update(view('original'),images);
    pending.resolve({ok:true,data:{...response(),items:[{id:'page-0',resultKey:'late-result'}]}});
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.results.size).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(messages('NC_INLINE_TICK')).toHaveLength(1);
    expect(messages('NC_INLINE_INVALIDATE').at(-1).keepIds).toEqual([]);
  });
});
