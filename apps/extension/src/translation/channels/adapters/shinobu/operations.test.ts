import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {parseConfig} from './config';
import {blockEntry,readCheckpoint,readOperation,saveCheckpoint,saveOperation,removeEntry,readInput,type LocalOperation} from './operations';
import {translateText} from './text/execute';
const operation=():LocalOperation=>({id:crypto.randomUUID(),scope:'fixture',entryId:crypto.randomUUID(),pageId:'page',fingerprint:'frozen-input',fontId:'lxgw-wenkai',config:parseConfig({provider:'llm',baseUrl:'http://127.0.0.1:1234/v1',model:'fixture'}),cacheToken:{epoch:0,ownerGeneration:0},job:{id:crypto.randomUUID(),mode:'classic',target_language:'zh-Hans',status:'running',phase:'detecting',created_at:new Date().toISOString(),version:1,quota_pages:0,cache_hit:false}});
beforeEach(()=>vi.restoreAllMocks());
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe('private local receipts',()=>{
  it('sends a whole page once and reuses its text after a render failure',async()=>{
    const record=operation(),input=Array.from({length:300},(_,i)=>({id:'r'+i,sourceText:i?'こんにちは':'文'.repeat(8001),translatedText:''}));
    const result=Object.fromEntries(input.map(region=>[region.id,'你好']));
    const fetcher=vi.fn(async(_url:string,_options:RequestInit)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})));vi.stubGlobal('fetch',fetcher);
    expect(await translateText(record,input,new AbortController().signal,'fixture-token')).toEqual(result);
    expect(await translateText(record,input,new AbortController().signal,'fixture-token')).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent=JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(JSON.parse(sent.messages[1].content)).toEqual(Object.fromEntries(input.map(region=>[region.id,region.sourceText])));
    expect((await readCheckpoint(record.job.id))?.state).toBe('succeeded');
  });
  it('allows slow requests to continue until the user cancels',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
    const controller=new AbortController(),fetcher=vi.fn((_url:string,options:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      options.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});started();
    }));vi.stubGlobal('fetch',fetcher);
    const task=translateText(operation(),[{id:'r0',sourceText:'test',translatedText:''}],controller.signal,'fixture-token');
    await ready;await vi.advanceTimersByTimeAsync(180_000);
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(false);
    const stopped=expect(task).rejects.toThrow('Aborted');controller.abort();await stopped;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not replay an unknown paid request on refresh',async()=>{
    const record=operation(),fetcher=vi.fn().mockRejectedValue(Error('Connection lost'));vi.stubGlobal('fetch',fetcher);
    const input=[{id:'r0',sourceText:'こんにちは',translatedText:''}];
    await expect(translateText(record,input,new AbortController().signal,'fixture-token')).rejects.toThrow();
    await expect(translateText(record,input,new AbortController().signal,'fixture-token')).rejects.toThrow('TEXT_OUTCOME_UNKNOWN');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects changed OCR input instead of assigning cached text by a new region order',async()=>{
    const record=operation();await saveCheckpoint({id:record.job.id,entryId:record.entryId,fingerprint:record.fingerprint,input:{r0:'before'},state:'succeeded',result:{r0:'之前'},updatedAt:Date.now(),bytes:0});
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(translateText(record,[{id:'r0',sourceText:'after',translatedText:''}],new AbortController().signal,'fixture-token')).rejects.toThrow('TEXT_CHECKPOINT_MISMATCH');expect(fetcher).not.toHaveBeenCalled();
  });
  it('fences late attempts and deleted entries in the same storage transaction',async()=>{
    const original=operation();await saveOperation(original,true);
    const replacement={...original,job:{...original.job,id:crypto.randomUUID()}};await saveOperation(replacement,true);
    await expect(saveOperation({...original,job:{...original.job,status:'succeeded'}})).rejects.toThrow('OPERATION_STALE');
    expect((await readOperation(original.id))?.job.id).toBe(replacement.job.id);
    await blockEntry(original.entryId);await expect(saveOperation(replacement)).rejects.toThrow('OPERATION_STALE');
    await expect(saveCheckpoint({id:replacement.job.id,entryId:original.entryId,fingerprint:'f',input:{},state:'sending',updatedAt:0,bytes:0})).rejects.toThrow('OPERATION_STALE');
  });
  it('cannot overwrite a committed completion with a late failure',async()=>{
    const record=operation();await saveOperation(record,true);await saveOperation({...record,job:{...record.job,status:'succeeded'}});
    await expect(saveOperation({...record,job:{...record.job,status:'failed'}})).rejects.toThrow('OPERATION_STALE');
    expect((await readOperation(record.id))?.job.status).toBe('succeeded');
  });
  it('removes private input and text for one entry while retaining other entries',async()=>{
    const removed=operation(),retained=operation();
    for(const record of [removed,retained]){
      await saveOperation(record,true,new Blob(['fixture source']));
      await saveCheckpoint({id:record.job.id,entryId:record.entryId,fingerprint:record.fingerprint,input:{r0:'private fixture'},state:'sending',updatedAt:0,bytes:0});
    }
    await removeEntry(removed.entryId);
    expect(await readOperation(removed.id)).toBeUndefined();expect(await readInput(removed.job.id)).toBeUndefined();expect(await readCheckpoint(removed.job.id)).toBeUndefined();
    expect(await readOperation(retained.id)).toBeDefined();expect(await readInput(retained.job.id)).toBeDefined();expect(await readCheckpoint(retained.job.id)).toBeDefined();
  });
});
