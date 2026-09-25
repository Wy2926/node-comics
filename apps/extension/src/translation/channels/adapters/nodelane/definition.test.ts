import 'fake-indexeddb/auto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Api} from '../../../../api';
import type {AuthState,Session} from '../../../../auth/model';
import {API_ORIGIN} from '../../../../service';
import type {Capabilities} from '../../../../types';
import {entitlement,job,target} from '../../../../../tests/translation-fixture';
import {definition} from './definition';
import {translationCache} from '../../../../storage/translations';
import {resultBlobKey} from '../../../../storage/translations/results';

const auth=vi.hoisted(()=>({value:{session:null} as AuthState,listeners:new Set<()=>void>()}));
vi.mock('../../../../auth/storage',()=>({
  readAuth:vi.fn(async()=>auth.value),
  subscribeAuth:(listener:()=>void)=>{auth.listeners.add(listener);return()=>auth.listeners.delete(listener);},
}));
const profile={id:'official',adapterId:'nodelane',name:'NodeLane',revision:1,settings:{}};
const capabilities:Capabilities={modes:[{id:'classic',label:'Classic',enabled:true}],languages:[{id:'zh-Hans',label:'Chinese'}],limits:{max_bytes:10_000_000,max_pixels:100_000_000,max_dimension:20_000,max_translation_ids:32},entitlements:null,retention_days:0};
function session(id=crypto.randomUUID()):Session{return {id,token:'fixture-token',user:{id:'user-'+id,name:'fixture',role:'reader'},apiOrigin:API_ORIGIN,expiresAt:Date.now()+3600000,refreshAt:Date.now()+3000000,credential:{kind:'development'}};}
const options=()=>({language:'zh-Hans',getBlob:async()=>undefined,onJobs:vi.fn(async()=>{}),onChange:vi.fn(),isCurrent:()=>true});
beforeEach(()=>{auth.value={session:null};auth.listeners.clear();});
afterEach(()=>vi.restoreAllMocks());

describe('NodeLane channel boundary',()=>{
  it('provides a login state without issuing account or translation requests while signed out',async()=>{
    const caps=vi.spyOn(Api.prototype,'capabilities'),rights=vi.spyOn(Api.prototype,'entitlements'),translate=vi.spyOn(Api.prototype,'translate');
    const connection=await definition.open(profile,{},()=>true),runtime=connection.createRuntime(options());
    await runtime.init();expect(connection.available).toBe(false);
    expect(connection.capabilities.modes.map(mode=>mode.id)).toEqual(['classic','redraw']);
    expect(runtime.stateFor(target(0),true)).toEqual({kind:'login',message:'登录后自动翻译'});
    await expect(runtime.submit([target(0)])).rejects.toThrow('登录');
    expect(caps).not.toHaveBeenCalled();expect(rights).not.toHaveBeenCalled();expect(translate).not.toHaveBeenCalled();connection.dispose();
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
    const connection=await definition.open(profile,{},()=>true),result=job(0,{status:'succeeded',output_asset_id:'output'});
    expect(connection.scope.key).toBe(JSON.stringify([API_ORIGIN,auth.value.session!.user.id]));
    await expect(connection.readResult(result)).rejects.toThrow('download failed');expect(download).toHaveBeenCalledWith(result.id,undefined);expect(translate).not.toHaveBeenCalled();connection.dispose();
  });
  it('reads official cached results without downloading again and keeps cancellation effective',async()=>{
    auth.value={session:session()};vi.spyOn(Api.prototype,'capabilities').mockResolvedValue(capabilities);vi.spyOn(Api.prototype,'entitlements').mockResolvedValue(entitlement());
    const download=vi.spyOn(Api.prototype,'translationImage'),connection=await definition.open(profile,{},()=>true),result=job(0,{status:'succeeded',output_asset_id:'cached-output'});
    await translationCache.put(resultBlobKey(connection.scope,result),new Blob(['cached translation']),{owner:connection.scope.key});
    expect(await(await connection.readResult(result)).text()).toBe('cached translation');expect(download).not.toHaveBeenCalled();
    const controller=new AbortController();controller.abort();await expect(connection.readResult(result,controller.signal)).rejects.toThrow();
    auth.value={session:null};await expect(connection.readResult(result)).rejects.toThrow();expect(download).not.toHaveBeenCalled();connection.dispose();
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
    expect(connection.available).toBe(true);expect(connection.scope.key).toBe(JSON.stringify([API_ORIGIN,auth.value.session!.user.id]));
    await runtime.init();expect(runtime.stateFor(target(0),true)?.message).toBe('offline');
    await expect(runtime.submit([target(0)])).rejects.toThrow('offline');expect(submit).not.toHaveBeenCalled();connection.dispose();
  });
});
