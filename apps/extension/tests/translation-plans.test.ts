import 'fake-indexeddb/auto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {ApiError} from '../src/api';
import {TranslationCoordinator} from '../src/translation/coordinator';
import {readOperation,saveOperation,saveSync} from '../src/translation/store';
import {operationId} from '../src/translation/automatic';
import {fixture,target,receipt,entitlement,job,origin} from './translation-fixture';
import type {PlanReceipt} from '../src/types';
afterEach(()=>vi.restoreAllMocks());
describe('translation plan coordination',()=>{
 it('adds one page per forward step while earlier translations are still queued, preserving operation keys',async()=>{
  const f=fixture(),keys=new Map<number,string>();
  for(let current=0;current<4;current++){
   await f.core.plan([current,current+1,current+2,current+3].map(target));
   const body=f.plan.mock.calls.at(-1)![0];
   expect(body.items.map(i=>Number(i.image.client_item_id.replace('page-','')))).toEqual([current,current+1,current+2,current+3]);
   expect(body.items.map(i=>i.role)).toEqual(['current','prefetch','prefetch','prefetch']);
   for(const item of body.items){const page=Number(item.image.client_item_id.replace('page-',''));if(keys.has(page))expect(item.operation_key).toBe(keys.get(page));else keys.set(page,item.operation_key);}
  }
  expect(keys.size).toBe(7);expect(f.plan).toHaveBeenCalledTimes(4);
 });
 it('admits new windows beyond the former in-flight cap without queue or matching reads',async()=>{
  const f=fixture(),match=vi.spyOn(f.api,'matchPages');
  for(let n=0;n<6;n++)await f.core.plan([target(n)]);
  expect(f.plan).toHaveBeenCalledTimes(6);expect(match).not.toHaveBeenCalled();
  await f.core.plan([target(5)]);expect(f.plan).toHaveBeenCalledTimes(6);
 });
 it('does not create a reading session before there is a reading window',async()=>{const f=fixture();await f.core.plan([]);expect(f.plan).not.toHaveBeenCalled();});
 it('persists each mixed receipt before uploading accepted images',async()=>{
  const f=fixture();f.plan.mockImplementation(async body=>({...receipt(body),items:body.items.map((i,n)=>n?{operation_key:i.operation_key,disposition:'deferred',code:'IMAGE_RATE_LIMITED',retry_after_seconds:8}:{operation_key:i.operation_key,disposition:'accepted',job:job(0,{status:'awaiting_upload'}),upload:{id:'upload',url:origin+'/upload',method:'PUT',headers:{},expires_at:'2099-01-01'}})}));
  const upload=vi.spyOn(f.api,'uploadOriginal').mockImplementation(async()=>{expect((await readOperation(operationId(f.core.scope,'zh-Hans',target(0))))?.state).toBe('accepted');});
  vi.spyOn(f.api,'completeUpload').mockResolvedValue(job(0));await f.core.plan([target(0),target(1)]);await f.core.finishUploads();
  expect(upload).toHaveBeenCalledOnce();expect(f.core.records.find(r=>r.pageId==='page-1')?.state).toBe('deferred');expect(f.core.retryDelay).toBeGreaterThan(7000);
  await f.core.plan([target(0),target(1)]);expect(f.plan).toHaveBeenCalledOnce();
 });
 it('resolves a lost response with the same key; an abandoned window is never resubmitted',async()=>{
  const f=fixture();f.plan.mockRejectedValueOnce(new ApiError('offline'));
  await expect(f.core.plan([target(1)])).rejects.toThrow('offline');
  const original=(await readOperation(operationId(f.core.scope,'zh-Hans',target(1))))!;original.retryAt=0;await saveOperation(original);
  await f.core.recover();await f.core.plan([target(2)]);
  expect(f.api.resolveOperations).toHaveBeenCalledWith([original.item.operation_key]);expect(f.plan.mock.calls[1][0].items[0].image.client_item_id).toBe('page-2');
  await f.core.plan([target(1)]);expect(f.plan.mock.calls[2][0].items[0].operation_key).toBe(original.item.operation_key);
 });
 it('does not clear image backpressure when a job finishes, but permits cache-only new windows',async()=>{
  const f=fixture();f.plan.mockImplementation(async body=>({...receipt(body),items:body.items.map(i=>({operation_key:i.operation_key,disposition:'deferred',code:body.allow_new?'IMAGE_RATE_LIMITED':'NEW_TRANSLATION_NOT_REQUESTED',retry_after_seconds:20}))}));
  await f.core.plan([target(0)]);await f.core.consume({items:[job(8,{status:'succeeded'})],deleted_job_ids:[],cursor:'1',has_more:false,policy_revision:'1',image_rate_limit:{window_seconds:60,limit:10}});
  expect(f.core.retryDelay).toBeGreaterThan(19000);await f.core.plan([target(1)]);expect(f.plan.mock.calls[1][0].allow_new).toBe(false);
 });
 it('ignores an old limited response arriving after a higher-rate policy update',async()=>{
  const f=fixture();let resolve!:(v:PlanReceipt)=>void;f.plan.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const pending=f.core.plan([target(0)]);await vi.waitFor(()=>expect(resolve).toBeDefined());
  await f.core.consume({items:[],deleted_job_ids:[],cursor:'0',has_more:false,policy_revision:'2',entitlements:entitlement(true),image_rate_limit:{window_seconds:60,limit:100}});
  const body=f.plan.mock.calls[0][0];resolve({policy_revision:'1',image_rate_limit:{window_seconds:60,limit:10},items:body.items.map(i=>({operation_key:i.operation_key,disposition:'deferred',code:'IMAGE_RATE_LIMITED',retry_after_seconds:30}))});await pending;
  expect(f.core.state.imageLimit).toBe(100);expect(f.core.retryDelay).toBe(0);await f.core.plan([target(0)]);expect(f.plan).toHaveBeenCalledTimes(2);
 });
 it('honors account control throttling across new windows and job notifications',async()=>{
  const f=fixture();f.plan.mockRejectedValueOnce(new ApiError('wait','PLAN_RATE_LIMITED',429,null,12,'control'));
  await expect(f.core.plan([target(0)])).rejects.toThrow('wait');await f.core.plan([target(1)]);expect(f.plan).toHaveBeenCalledOnce();
  await f.core.consume({items:[job(8)],deleted_job_ids:[],cursor:'1',has_more:false,policy_revision:'1'});expect(f.core.controlDelay).toBeGreaterThan(11000);
  await saveSync({...f.core.state,controlRetryAt:undefined});await f.core.plan([target(1)]);expect(f.plan).toHaveBeenCalledTimes(2);
 });
 it('directly consumes long-poll payload and keeps cursor and deletion tombstones together',async()=>{
  const f=fixture();vi.spyOn(f.api,'waitForTranslationChanges').mockResolvedValue({items:[job(1)],deleted_job_ids:[],cursor:'1',has_more:false,policy_revision:'1'});
  const repeat=vi.spyOn(f.api,'translationChanges');await f.core.wait(new AbortController().signal);
  expect(repeat).not.toHaveBeenCalled();expect(f.core.state.jobs[0].id).toBe('job-1');
  await f.core.consume({items:[],deleted_job_ids:['job-1'],cursor:'2',has_more:false,policy_revision:'1'});expect(f.core.state.jobs[0]).toMatchObject({result_expired:true,output_asset_id:null});expect(f.core.state.cursor).toBe('2');
 });
 it('serializes plan requests for a reading context',async()=>{
  const f=fixture();let resolve!:(v:PlanReceipt)=>void;f.plan.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const first=f.core.plan([target(0)]);await vi.waitFor(()=>expect(resolve).toBeDefined());await f.core.plan([target(1)]);expect(f.plan).toHaveBeenCalledOnce();resolve(receipt(f.plan.mock.calls[0][0]));await first;await f.core.plan([target(1)]);expect(f.plan).toHaveBeenCalledTimes(2);
 });
 it('finishes the older plan before a manual retry can replace its operation key',async()=>{
  const f=fixture();let resolve!:(v:PlanReceipt)=>void;f.plan.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const first=f.core.plan([target(1)]);await vi.waitFor(()=>expect(resolve).toBeDefined());
  const failed={...target(1),page:{...target(1).page,ownerId:f.userId,apiOrigin:origin,jobs:[job(1,{status:'failed'})]}};
  const retry=f.core.manual(failed);await f.core.plan([target(1)]);expect(f.plan).toHaveBeenCalledOnce();const original=f.plan.mock.calls[0][0];resolve({...receipt(original),items:[{operation_key:original.items[0].operation_key,disposition:'blocked',job:job(1,{status:'failed'})}]});await first;await retry;
  expect(f.plan).toHaveBeenCalledTimes(2);expect(f.plan.mock.calls[1][0].trigger).toBe('manual');expect(f.plan.mock.calls[1][0].items[0].operation_key).not.toBe(original.items[0].operation_key);expect((await readOperation(operationId(f.core.scope,'zh-Hans',target(1))))?.item.operation_key).toBe(f.plan.mock.calls[1][0].items[0].operation_key);
 });
 it('uses the current feed status when retrying a previously accepted failed job',async()=>{
  const f=fixture();await f.core.plan([target(1)]);await f.core.consume({items:[job(1,{status:'failed',updated_at:'2026-09-19T01:00:00Z'})],deleted_job_ids:[],cursor:'2',has_more:false});
  await f.core.manual({...target(1),page:{...target(1).page,ownerId:f.userId,apiOrigin:origin,jobs:[job(1,{status:'failed'})]}});expect(f.plan.mock.calls[1][0].items[0].action).toBe('retry');
 });
 it('keeps other reading pages eligible after a manual operation is definitively blocked',async()=>{
  const f=fixture();f.plan.mockImplementationOnce(async body=>({...receipt(body),items:[{operation_key:body.items[0].operation_key,disposition:'blocked',code:'RETRY_NOT_ALLOWED',job:job(1,{status:'failed'})}]}));const failed={...target(1),page:{...target(1).page,ownerId:f.userId,apiOrigin:origin,jobs:[job(1,{status:'failed'})]}};await f.core.manual(failed);await f.core.plan([failed,target(2),target(3)]);expect(f.plan).toHaveBeenCalledTimes(2);expect(f.plan.mock.calls[1][0].trigger).toBe('reading');expect(f.plan.mock.calls[1][0].items).toHaveLength(3);expect(f.plan.mock.calls[1][0].items[0].action).toBeUndefined();
 });
 it('renews an expired session in its stable persisted slot without changing operation keys',async()=>{
  const f=fixture(),slot=f.core.options.sessionId;await f.core.plan([target(1)]);const oldSession=f.plan.mock.calls[0][0].session_id;
  vi.spyOn(f.api,'lease').mockRejectedValueOnce(new ApiError('expired','READING_SESSION_EXPIRED',409));await f.core.renew(['classic'],true);await f.core.plan([target(1)]);
  expect(f.plan.mock.calls[1][0].session_id).not.toBe(oldSession);expect(f.plan.mock.calls[1][0].items[0].operation_key).toBe(f.plan.mock.calls[0][0].items[0].operation_key);
  const reopened=new TranslationCoordinator({...f.core.options,sessionId:slot});await reopened.init();expect(reopened.options.sessionId).toBe(f.plan.mock.calls[1][0].session_id);expect(reopened.session.sequence).toBe(1);
 });
 it.each(['resolve','lease'])('honors Retry-After received from %s across new reading windows',async endpoint=>{
  const f=fixture();await f.core.plan([target(1)]);const error=new ApiError('slow down','CONTROL_RATE_LIMITED',429,null,18,'control');
  if(endpoint==='resolve'){const record=(await readOperation(operationId(f.core.scope,'zh-Hans',target(1))))!;record.state='uncertain';await saveOperation(record);vi.mocked(f.api.resolveOperations).mockRejectedValueOnce(error);await expect(f.core.recover()).rejects.toThrow('slow down');}
  else{vi.spyOn(f.api,'lease').mockRejectedValueOnce(error);await expect(f.core.renew(['classic'],true)).rejects.toThrow('slow down');}
  await f.core.plan([target(2)]);expect(f.plan).toHaveBeenCalledOnce();expect(f.core.controlDelay).toBeGreaterThan(17000);
 });
 it('leaves a prepared old window unsent after the user hides or navigates away',async()=>{
  const f=fixture();await f.core.plan([target(1)],false,()=>false);expect(f.plan).not.toHaveBeenCalled();const prepared=(await readOperation(operationId(f.core.scope,'zh-Hans',target(1))))!;expect(prepared.state).toBe('local');await f.core.plan([target(2)]);expect(f.plan.mock.calls[0][0].items[0].image.client_item_id).toBe('page-2');
 });
 it('replaces a definite quota denial with a new key after policy changes',async()=>{
  const f=fixture();f.plan.mockImplementationOnce(async body=>({...receipt(body),items:[{operation_key:body.items[0].operation_key,disposition:'blocked',code:'DAILY_QUOTA_EXHAUSTED'}]}));await f.core.plan([target(1)]);await f.core.refreshPolicy(entitlement(true));await f.core.plan([target(1)]);expect(f.plan.mock.calls[1][0].items[0].operation_key).not.toBe(f.plan.mock.calls[0][0].items[0].operation_key);expect((await readOperation(operationId(f.core.scope,'zh-Hans',target(1))))?.item.operation_key).toBe(f.plan.mock.calls[1][0].items[0].operation_key);
 });
 it('manual first attempts use ensure, failed work uses retry, and unknown work stays frozen',async()=>{
  const f=fixture();await f.core.manual(target(0));expect(f.plan.mock.calls[0][0]).toMatchObject({trigger:'manual',items:[{action:'ensure'}]});
  const failed={...target(1),page:{...target(1).page,ownerId:f.userId,apiOrigin:origin,jobs:[job(1,{status:'failed'})]}};
  await f.core.manual(failed);expect(f.plan.mock.calls[1][0]).toMatchObject({trigger:'manual',items:[{action:'retry',source_job_id:'job-1'}]});
  const unknown={...target(2),page:{...target(2).page,ownerId:f.userId,apiOrigin:origin,jobs:[job(2,{status:'unknown_released'})]}};
  await expect(f.core.manual(unknown)).rejects.toThrow('核实');expect(f.plan).toHaveBeenCalledTimes(2);
 });
 it('never forwards the bearer token to signed object storage',async()=>{
  const f=fixture(),calls:RequestInit[]=[];vi.stubGlobal('fetch',async(_url:URL,init:RequestInit)=>{calls.push(init);return new Response(null,{status:200});});
  try{await f.api.uploadOriginal({id:'u',url:'https://bucket.r2.example/raw',method:'PUT',headers:{},expires_at:'2099-01-01'},new Blob(['x']));expect(calls[0].headers).not.toHaveProperty('Authorization');expect(calls[0].credentials).toBe('omit');}finally{vi.unstubAllGlobals();}
 });
});
