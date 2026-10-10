import {deliveredBytes,deliveredResult} from '../../../../../tests/overlay-fixture';
import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Api} from '../../../../api';
import type {AuthState,Session} from '../../../../auth/model';
import {API_ORIGIN} from '../../../../service';
import type {Capabilities,Job} from '../../../../types';
import {entitlement,job,target,originalBytes,originalInput,snapshot} from '../../../../../tests/translation-fixture';
import {makeOperation} from './operations';
import {saveOperation} from './store';
import {definition} from './definition';
import {translationCache} from '../../../../storage/translations';
import {resultBlobKey} from '../../../../storage/translations/results';
import {cacheInput,readInput} from '../../../input/cache';
import {hashFile} from '../../../../importers/hash';
import {readChannelSettings,writeChannelSettings} from '../../configuration';

const auth=vi.hoisted(()=>({value:{session:null} as AuthState,listeners:new Set<()=>void>()}));
vi.mock('../../../../auth/storage',()=>({
  readAuth:vi.fn(async()=>auth.value),
  subscribeAuth:(listener:()=>void)=>{auth.listeners.add(listener);return()=>auth.listeners.delete(listener);},
}));
const profile={id:'official',adapterId:'nodelane',name:'NodeLane',revision:1,settings:{}};
const capabilities:Capabilities={modes:[{id:'classic',label:'Classic',enabled:true}],languages:[{id:'zh-Hans',label:'Chinese'}],limits:{max_bytes:10_000_000,max_pixels:100_000_000,max_dimension:20_000,max_translation_ids:32},entitlements:null};
function session(id=crypto.randomUUID()):Session{return {id,token:'fixture-token',user:{id:'user-'+id,name:'fixture',role:'reader'},apiOrigin:API_ORIGIN,expiresAt:Date.now()+3600000,refreshAt:Date.now()+3000000,credential:{kind:'development'}};}
const options=()=>({language:'zh-Hans',getBlob:async()=>undefined,onJobs:vi.fn(async(_jobs:Job[])=>{}),onChange:vi.fn(),isCurrent:()=>true});
beforeEach(()=>{auth.value={session:null};auth.listeners.clear();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('NodeLane channel boundary',()=>{
  it('opens the inline local-cache path without contacting policy, while new admission still requires it',async()=>{
    auth.value={session:session()};
    const caps=vi.spyOn(Api.prototype,'capabilities').mockRejectedValue(Error('offline'));
    const rights=vi.spyOn(Api.prototype,'entitlements').mockRejectedValue(Error('offline'));
    const translate=vi.spyOn(Api.prototype,'translate');
    const connection=await definition.open(profile,{},()=>true,{deferPolicy:true});
    const runtime=connection.createRuntime(options());await runtime.init();await runtime.restore([target(0)]);
    expect(caps).not.toHaveBeenCalled();expect(rights).not.toHaveBeenCalled();
    await expect(runtime.submit([target(0)])).rejects.toThrow('offline');
    expect(caps).toHaveBeenCalledOnce();expect(translate).not.toHaveBeenCalled();connection.dispose();
  });
  it.each(['mode','language'] as const)('disabled %s blocks new tasks, not accepted UUID recovery or its state',async unavailable=>{
    auth.value={session:session()};
    vi.spyOn(Api.prototype,'capabilities').mockResolvedValue({...capabilities,modes:[{id:'classic',label:'Classic',enabled:unavailable!=='mode',languages:unavailable==='language'?['en']:['zh-Hans']}]});
    vi.spyOn(Api.prototype,'entitlements').mockResolvedValue(entitlement());
    const translate=vi.spyOn(Api.prototype,'translate'),connection=await definition.open(profile,{},()=>true),page=target(0),fresh=target(1);
    const record=makeOperation(page,connection.scope.key,'zh-Hans',originalInput(0));
    record.state='accepted';record.result=snapshot(record.requestId,record.request);await saveOperation(record);
    const local=makeOperation(fresh,connection.scope.key,'zh-Hans',originalInput(1));await saveOperation(local);
    const recover=vi.spyOn(Api.prototype,'translations').mockResolvedValue({items:[record.result],missing_ids:[],unchanged:false,etag:'accepted'});
    const settings=options();settings.onJobs.mockImplementation(async jobs=>{page.page.translationScope=connection.scope.key;page.page.jobs=jobs;});
    const runtime=connection.createRuntime(settings);await runtime.submit([page,fresh,target(2)]);
    expect(recover).toHaveBeenCalledWith([record.requestId],expect.anything());
    expect(runtime.waitingIds).toEqual([record.requestId]);expect(runtime.stateFor(page,true)?.kind).toBe('waiting');
    expect(runtime.stateFor(target(2),true)?.kind).toBe('error');expect(translate).not.toHaveBeenCalled();
    await expect(runtime.manual(fresh)).rejects.toThrow('不可用');connection.dispose();
  });
  it('isolates model preferences by user and center, preserving stale selections after entitlement changes',async()=>{
    const saved=new Map<string,string>();
    vi.stubGlobal('localStorage',{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    const model={id:'model-a',name:'Model A',requires_paid:true,available:true};
    const readCaps=vi.spyOn(Api.prototype,'capabilities').mockResolvedValue({...capabilities,translation_models:[model]});
    vi.spyOn(Api.prototype,'entitlements').mockResolvedValue(entitlement());
    const first=session(),second=session();auth.value={session:first};
    const connection=await definition.open(profile,{},()=>true);
    await connection.modelSelection!.select('model-a');connection.dispose();
    const settings=await readChannelSettings();
    await writeChannelSettings({...settings,modelPreferences:{...settings.modelPreferences,'other-center':'other-model'}});
    auth.value={session:second};
    const other=await definition.open(profile,{},()=>true);expect(other.modelSelection!.value).toBeUndefined();other.dispose();
    auth.value={session:first};
    readCaps.mockResolvedValue({...capabilities,translation_models:[{...model,available:false,unavailable_reason:'not_allowed'}]});
    const restored=await definition.open(profile,{},()=>true);
    expect(restored.modelSelection!.value).toBe('model-a');
    await expect(restored.modelSelection!.select('model-a')).rejects.toThrow('不可用');
    await restored.modelSelection!.select();
    expect((await readChannelSettings()).modelPreferences).toEqual({'other-center':'other-model'});restored.dispose();
  });
  it('provides a login state without issuing account or translation requests while signed out',async()=>{
    const caps=vi.spyOn(Api.prototype,'capabilities').mockResolvedValue(capabilities),rights=vi.spyOn(Api.prototype,'entitlements'),translate=vi.spyOn(Api.prototype,'translate');
    const connection=await definition.open(profile,{},()=>true),runtime=connection.createRuntime(options());
    await runtime.init();expect(connection.available).toBe(false);
    expect(connection.capabilities.modes.map(mode=>mode.id)).toEqual(['classic']);
    expect(runtime.stateFor(target(0),true)).toEqual({kind:'login',message:'登录后自动翻译'});
    await expect(runtime.submit([target(0)])).rejects.toThrow('登录');
    expect(caps).toHaveBeenCalledOnce();expect(rights).not.toHaveBeenCalled();expect(translate).not.toHaveBeenCalled();connection.dispose();
  });
  it('notifies on session changes and ignores token-only refreshes',async()=>{
    const first=session();auth.value={session:first};const changed=vi.fn(),unsubscribe=definition.subscribe!(changed);
    await Promise.resolve();
    auth.value={session:{...first,token:'refreshed'}};for(const notify of auth.listeners)notify();
    await new Promise(resolve=>setTimeout(resolve,0));expect(changed).not.toHaveBeenCalled();
    auth.value={session:session()};for(const notify of auth.listeners)notify();
    await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce());
    auth.value={session:null};for(const notify of auth.listeners)notify();
    await vi.waitFor(()=>expect(changed).toHaveBeenCalledTimes(2));unsubscribe();expect(auth.listeners.size).toBe(0);
  });
  it('reloads a delivered image through the official endpoint without resubmitting on failure',async()=>{
    auth.value={session:session()};vi.spyOn(Api.prototype,'capabilities').mockResolvedValue(capabilities);vi.spyOn(Api.prototype,'entitlements').mockResolvedValue(entitlement());
    const download=vi.spyOn(Api.prototype,'translationImage').mockRejectedValue(new Error('download failed')),translate=vi.spyOn(Api.prototype,'translate');
    const connection=await definition.open(profile,{},()=>true),result=job(0,{status:'succeeded',delivery:deliveredResult('job-0')});
    expect(connection.scope.key).toBe(JSON.stringify([API_ORIGIN,auth.value.session!.user.id,'overlay-v1']));
    await expect(connection.readResult(result)).rejects.toThrow('download failed');expect(download).toHaveBeenCalledWith(result.id,undefined);expect(translate).not.toHaveBeenCalled();connection.dispose();
  });
  it('reads official cached results without downloading again and keeps cancellation effective',async()=>{
    auth.value={session:session()};vi.spyOn(Api.prototype,'capabilities').mockResolvedValue(capabilities);vi.spyOn(Api.prototype,'entitlements').mockResolvedValue(entitlement());
    const download=vi.spyOn(Api.prototype,'translationImage'),submit=vi.spyOn(Api.prototype,'translate'),connection=await definition.open(profile,{},()=>true),result=job(0,{status:'succeeded',delivery:deliveredResult('job-0')});vi.stubGlobal('createImageBitmap',async()=>({width:800,height:1200,close(){}}));
    await translationCache.put(resultBlobKey(connection.scope,result),deliveredBytes,{owner:connection.scope.key});
    expect(await(await connection.readResult(result)).text()).toBe('image');expect(download).not.toHaveBeenCalled();
    const controller=new AbortController();controller.abort();await expect(connection.readResult(result,controller.signal)).rejects.toThrow();
    auth.value={session:null};await expect(connection.readResult(result)).rejects.toThrow();expect(download).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();connection.dispose();
  });
  it.each([false,true])('reads prepared input through the shared loader with cache hit=%s without submitting',async cached=>{
    auth.value={session:session()};vi.spyOn(Api.prototype,'capabilities').mockResolvedValue(capabilities);vi.spyOn(Api.prototype,'entitlements').mockResolvedValue(entitlement());
    const download=vi.spyOn(Api.prototype,'translationImage'),translate=vi.spyOn(Api.prototype,'translate');
    const connection=await definition.open(profile,{},()=>true),source=originalBytes(0);
    const encoded=new Blob(['RIFF',new Uint8Array([14,0,0,0]),'WEBPVP8 ',new Uint8Array([2,0,0,0]),'ok'],{type:'image/webp'}),sha=await hashFile(encoded);
    const encode=vi.fn(async()=>encoded),original=vi.fn(async()=>source);
    vi.stubGlobal('Worker',undefined);vi.stubGlobal('createImageBitmap',async()=>({width:800,height:1200,close(){}}));
    vi.stubGlobal('OffscreenCanvas',class {getContext(){return {drawImage(){}};}convertToBlob=encode;});
    const result=job(0,{id:crypto.randomUUID(),status:'succeeded',source_image_sha256:await hashFile(source),input_profile:'short-edge-1800-webp90-v1',delivery:{kind:'translated',representation:'original',normalization_version:1,input_sha256:sha,width:800,height:1200}});
    if(cached)await cacheInput(connection.scope.key,sha,encoded);
    expect(await hashFile(await connection.readResult(result,undefined,original))).toBe(sha);
    expect(await hashFile((await readInput(connection.scope.key,sha))!)).toBe(sha);
    await connection.readResult(result,undefined,original);
    expect(original).toHaveBeenCalledTimes(cached?0:1);expect(encode).toHaveBeenCalledTimes(cached?0:1);
    expect(download).not.toHaveBeenCalled();expect(translate).not.toHaveBeenCalled();connection.dispose();
  });
  it('does not submit a manual retry when refreshing account policy fails',async()=>{
    auth.value={session:session()};vi.spyOn(Api.prototype,'capabilities').mockResolvedValue(capabilities);
    const rights=vi.spyOn(Api.prototype,'entitlements').mockResolvedValue(entitlement()),translate=vi.spyOn(Api.prototype,'translate');
    const connection=await definition.open(profile,{},()=>true),runtime=connection.createRuntime(options());rights.mockRejectedValueOnce(new Error('offline'));
    await expect(runtime.manual(target(0))).rejects.toThrow('offline');expect(translate).not.toHaveBeenCalled();connection.dispose();
    await expect(runtime.submit([target(0)])).rejects.toThrow('已切换');
  });
  it('retains the authenticated cache scope during a policy outage without admitting new translations',async()=>{
    auth.value={session:session()};vi.spyOn(Api.prototype,'capabilities').mockRejectedValue(new Error('offline'));vi.spyOn(Api.prototype,'entitlements').mockRejectedValue(new Error('offline'));
    const submit=vi.spyOn(Api.prototype,'translate'),connection=await definition.open(profile,{},()=>true),runtime=connection.createRuntime(options());
    expect(connection.available).toBe(true);expect(connection.scope.key).toBe(JSON.stringify([API_ORIGIN,auth.value.session!.user.id,'overlay-v1']));
    await runtime.init();expect(runtime.stateFor(target(0),true)?.message).toBe('offline');
    await expect(runtime.submit([target(0)])).rejects.toThrow('offline');expect(submit).not.toHaveBeenCalled();connection.dispose();
  });
});
