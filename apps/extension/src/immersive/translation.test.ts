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
  it.each(['reset','window'] as const)('ignores an old WAIT rejection after a %s without delaying the current generation',async change=>{
    const oldWait=Promise.withResolvers<{ok:boolean;data:InlineResponse}>();let ticks=0;
    sendMessage.mockImplementation(async message=>{
      if(message.type==='NC_INLINE_WAIT')return oldWait.promise;
      if(message.type==='NC_INLINE_TICK')return {ok:true,data:{...response(++ticks),hasPending:ticks===1}};
      return {ok:true};
    });
    const {value}=client();value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    expect(messages('NC_INLINE_WAIT')).toHaveLength(1);
    if(change==='reset')value.reset();else value.update({...view(),pageIds:images.slice(1).map(image=>image.id)},images.slice(1));
    await vi.advanceTimersByTimeAsync(1);expect(messages('NC_INLINE_TICK')).toHaveLength(2);
    oldWait.reject(Error('Old transport failed'));await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    value.update({...view(),pageIds:images.slice(2).map(image=>image.id)},images.slice(2));await vi.advanceTimersByTimeAsync(1);
    expect(messages('NC_INLINE_TICK')).toHaveLength(3);
    expect(messages('NC_INLINE_TICK').at(-1).deferRemote).toBeUndefined();
    await vi.advanceTimersByTimeAsync(6000);expect(messages('NC_INLINE_TICK')).toHaveLength(3);
  });

  it.each(['push','window'] as const)('keeps WAIT RetryAfter across a %s update without delaying cached results or new window preparation',async change=>{
    let ticks=0,waits=0,revision=0;
    sendMessage.mockImplementation(async message=>{
      if(message.type==='NC_INLINE_TICK'){ticks++;return {ok:true,data:{...response(++revision),hasPending:true}};}
      if(message.type==='NC_INLINE_WAIT')return ++waits===1?{ok:false,error:'Retry later',retryAfterMs:5000}:{ok:true,data:response(++revision)};
      return {ok:true};
    });
    const {value}=client();value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    expect(messages('NC_INLINE_WAIT')).toHaveLength(1);const deadline=performance.now()+5000;
    await vi.advanceTimersByTimeAsync(50);
    if(change==='window'){
      value.update({...view(),pageIds:images.slice(1).map(image=>image.id)},images.slice(1));await vi.advanceTimersByTimeAsync(1);
      expect(messages('NC_INLINE_TICK')).toHaveLength(2);
      expect(messages('NC_INLINE_TICK').at(-1).deferRemote).toBeUndefined();
    }
    const current=messages('NC_INLINE_TICK').at(-1);
    value.onMessage({type:'NC_INLINE_UPDATE',navigationId:'navigation',generation:current.generation,
      data:{...response(++revision),hasPending:true,items:[{id:current.images[0].id,resultKey:'cached-result'}]}});
    await vi.advanceTimersByTimeAsync(1);
    expect(value.results.get(current.images[0].id)?.resultKey).toBe('cached-result');
    expect(messages('NC_INLINE_WAIT')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(deadline-performance.now()-1);expect(messages('NC_INLINE_WAIT')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);expect(messages('NC_INLINE_WAIT')).toHaveLength(2);
    expect(messages('NC_INLINE_TICK')).toHaveLength(ticks);expect(ticks).toBe(change==='window'?2:1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues accepted-task subscriptions during new-image admission backoff',async()=>{
    const waiting=Promise.withResolvers<{ok:boolean;data:InlineResponse}>();
    sendMessage.mockImplementation(async message=>message.type==='NC_INLINE_WAIT'?waiting.promise:message.type==='NC_INLINE_TICK'
      ? {ok:true,data:{...response(),hasPending:true,retryAfterMs:5000}}:{ok:true});
    const {value}=client();value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    expect(messages('NC_INLINE_WAIT')).toHaveLength(1);
    waiting.resolve({ok:true,data:response(2)});await vi.advanceTimersByTimeAsync(1);
  });

  it.each(['rejection','response'] as const)('recovers repeated WAIT %s failures with its own bounded retry and no extra TICK',async failure=>{
    let waits=0;
    sendMessage.mockImplementation(async message=>{
      if(message.type==='NC_INLINE_TICK')return {ok:true,data:{...response(),hasPending:true}};
      if(message.type==='NC_INLINE_WAIT'){
        if(++waits<3){if(failure==='rejection')throw Error('Transport unavailable');return {ok:false,error:'Transport unavailable'};}
        return {ok:true,data:response(2)};
      }
      return {ok:true};
    });
    const {value}=client();value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    expect(messages('NC_INLINE_WAIT')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);expect(messages('NC_INLINE_WAIT')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);expect(messages('NC_INLINE_WAIT')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);expect(messages('NC_INLINE_WAIT')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);expect(messages('NC_INLINE_WAIT')).toHaveLength(3);
    expect(messages('NC_INLINE_TICK')).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
  });

  it('removes a pending WAIT wakeup when a pushed completion no longer needs a subscription',async()=>{
    sendMessage.mockImplementation(async message=>message.type==='NC_INLINE_TICK'?{ok:true,data:{...response(),hasPending:true}}
      :message.type==='NC_INLINE_WAIT'?{ok:false,error:'Retry later',retryAfterMs:5000}:{ok:true});
    const {value}=client();value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    const generation=messages('NC_INLINE_TICK')[0].generation;
    value.onMessage({type:'NC_INLINE_UPDATE',navigationId:'navigation',generation,data:response(2)});
    expect(vi.getTimerCount()).toBe(0);await vi.advanceTimersByTimeAsync(6000);
    expect(messages('NC_INLINE_WAIT')).toHaveLength(1);expect(messages('NC_INLINE_TICK')).toHaveLength(1);
  });

  it.each(['original','hidden','disposed'] as const)('clears WAIT wakeups while %s and retains the remaining retry deadline when resumed',async stopped=>{
    let waits=0,revision=0;
    sendMessage.mockImplementation(async message=>{
      if(message.type==='NC_INLINE_TICK')return {ok:true,data:{...response(++revision),hasPending:true}};
      if(message.type==='NC_INLINE_WAIT')return ++waits===1?{ok:false,error:'Retry later',retryAfterMs:5000}:{ok:true,data:response(++revision)};
      return {ok:true};
    });
    const {value}=client();value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    const deadline=performance.now()+5000;
    if(stopped==='original')value.update(view('original'),images);
    else if(stopped==='hidden'){visibility.hidden=true;value.update(view(),images);}
    else value.dispose();
    expect(vi.getTimerCount()).toBe(0);await vi.advanceTimersByTimeAsync(1000);
    expect(messages('NC_INLINE_WAIT')).toHaveLength(1);expect(messages('NC_INLINE_TICK')).toHaveLength(1);
    if(stopped==='disposed'){await vi.advanceTimersByTimeAsync(6000);expect(vi.getTimerCount()).toBe(0);return;}
    visibility.hidden=false;value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    expect(messages('NC_INLINE_TICK')).toHaveLength(2);
    expect(messages('NC_INLINE_TICK').at(-1).deferRemote).toBeUndefined();
    expect(messages('NC_INLINE_WAIT')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(deadline-performance.now()-1);expect(messages('NC_INLINE_WAIT')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);expect(messages('NC_INLINE_WAIT')).toHaveLength(2);
    expect(messages('NC_INLINE_TICK')).toHaveLength(2);expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined,5000])('resumes remote work after a window change during backoff (server delay: %s)',async retryAfterMs=>{
    let ticks=0;
    sendMessage.mockImplementation(async message=>message.type==='NC_INLINE_TICK'&&++ticks===1
      ? {ok:false,error:'Temporary failure',retryAfterMs}
      : {ok:true,data:response(ticks+1)});
    const {value}=client();value.update(view(),images);
    await vi.advanceTimersByTimeAsync(150);
    const deadline=150+(retryAfterMs??1000);
    await vi.advanceTimersByTimeAsync(50);
    value.update({...view(),pageIds:images.slice(1).map(image=>image.id)},images.slice(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(messages('NC_INLINE_TICK')).toHaveLength(2);
    expect(messages('NC_INLINE_TICK')[1].deferRemote).toBe('backoff');
    await vi.advanceTimersByTimeAsync(deadline-performance.now()-1);
    expect(messages('NC_INLINE_TICK')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages('NC_INLINE_TICK')).toHaveLength(3);
    expect(messages('NC_INLINE_TICK')[2].deferRemote).toBeUndefined();
  });

  it('resumes once when local recovery finishes after the retry deadline',async()=>{
    const restore=Promise.withResolvers<{ok:boolean;data:InlineResponse}>();let ticks=0;
    sendMessage.mockImplementation(async message=>{
      if(message.type!=='NC_INLINE_TICK')return {ok:true,data:response()};
      ticks++;
      if(ticks===1)return {ok:false,error:'Temporary failure'};
      if(ticks===2)return restore.promise;
      return {ok:true,data:response(ticks)};
    });
    const {value}=client();value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    value.update({...view(),pageIds:images.slice(1).map(image=>image.id)},images.slice(1));
    await vi.advanceTimersByTimeAsync(2000);
    expect(messages('NC_INLINE_TICK')).toHaveLength(2);
    restore.resolve({ok:true,data:response(2)});await vi.advanceTimersByTimeAsync(1);
    expect(messages('NC_INLINE_TICK')).toHaveLength(3);
    expect(messages('NC_INLINE_TICK')[2].deferRemote).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30000);expect(messages('NC_INLINE_TICK')).toHaveLength(3);
  });

  it.each(['original','hidden','disposed'])('does not wake deferred remote work after becoming %s',async stopped=>{
    sendMessage.mockImplementation(async message=>message.type==='NC_INLINE_TICK'
      ? {ok:false,error:'Temporary failure',retryAfterMs:5000}
      : {ok:true,data:response()});
    const {value}=client();value.update(view(),images);await vi.advanceTimersByTimeAsync(150);
    if(stopped==='original')value.update(view('original'),images);
    else if(stopped==='hidden'){visibility.hidden=true;value.update(view(),images);}
    else value.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(messages('NC_INLINE_TICK')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

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
