import {afterEach,describe,it,expect,vi} from 'vitest';
import {Api} from '../src/api';
import {POLICY_TTL} from '../src/api-cache';
import {entitlement} from './translation-fixture';
const api=(base:string,session='account-a')=>new Api(base,'token',undefined,undefined,{cacheKey:session,current:async()=>{},token:async()=>'token',reject:async()=>{}});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();vi.restoreAllMocks();});
describe('session policy cache',()=>{
  it('keeps HTTP failures diagnosable even if a gateway returns null or a batch uses detail',async()=>{
    const a=api('https://invalid-response.example');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json(null,{status:502})).mockResolvedValueOnce(Response.json({detail:{message:'Server busy',code:'CONTROL_LIMIT'}},{status:503,headers:{'Retry-After':'4'}})));
    await expect(a.authConfig()).rejects.toMatchObject({status:502,code:'REQUEST_FAILED',message:'请求未完成（502）'});
    await expect(a.translations(['page'])).rejects.toMatchObject({status:503,code:'CONTROL_LIMIT',message:'Server busy',retryAfterSeconds:4});
  });
  it('rereads an incomplete sign-in configuration on explicit reconnect',async()=>{
    const a=api('https://login-config.example');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({mode:'oidc'})).mockResolvedValueOnce(Response.json({mode:'oidc',client_id:'repaired'})));
    expect((await a.authConfig()).client_id).toBeUndefined();
    expect((await a.authConfig(true)).client_id).toBe('repaired');
  });
  it('merges concurrent readers and reuses capabilities entitlements across API instances',async()=>{
    const base='https://'+crypto.randomUUID()+'.example',rights=entitlement(),caps={result_protocol:'overlay-v1',modes:[{id:'classic',label:'Classic',enabled:true}],entitlements:rights};
    const fetch=vi.fn(async()=>Response.json(caps));vi.stubGlobal('fetch',fetch);
    const a=api(base),b=api(base);await Promise.all([a.capabilities(),b.capabilities()]);
    await Promise.all([a.entitlements(),b.entitlements(),a.capabilities()]);expect(fetch).toHaveBeenCalledOnce();
    expect(await b.entitlements()).toEqual(rights);
  });
  it('isolates API origins and login sessions, and expires without background polling',async()=>{
    vi.useFakeTimers();const base='https://'+crypto.randomUUID()+'.example',fetch=vi.fn(async()=>Response.json(entitlement()));vi.stubGlobal('fetch',fetch);
    await api(base).entitlements();await api(base).entitlements();expect(fetch).toHaveBeenCalledOnce();
    await api(base,'account-b').entitlements();await api(base+'/other').entitlements();expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(POLICY_TTL+1);expect(fetch).toHaveBeenCalledTimes(3);
    await api(base).entitlements();expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('explicit refresh bypasses TTL but merges simultaneous refreshes; failures remain retryable',async()=>{
    const base='https://'+crypto.randomUUID()+'.example',fetch=vi.fn().mockResolvedValue(Response.json(entitlement()));vi.stubGlobal('fetch',fetch);
    await api(base).entitlements();fetch.mockImplementation(async()=>Response.json(entitlement(true)));
    await Promise.all([api(base).entitlements(true),api(base).entitlements(true)]);expect(fetch).toHaveBeenCalledTimes(2);expect((await api(base).entitlements()).plan).toBe('plus');
    fetch.mockRejectedValueOnce(Error('offline'));await expect(api(base).entitlements(true)).rejects.toThrow();await api(base).entitlements();expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('does not let an older in-flight entitlement read overwrite a billing refresh',async()=>{
    const base='https://'+crypto.randomUUID()+'.example';let finish!:(response:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
    const a=api(base),pending=a.entitlements();await vi.waitFor(()=>expect(finish).toBeDefined());a.rememberEntitlements(entitlement(true));finish(Response.json(entitlement()));await pending;
    expect((await api(base).entitlements()).plan).toBe('plus');
  });
  it('keeps newer billing rights when an older cached usage summary is displayed',async()=>{
    const a=api('https://'+crypto.randomUUID()+'.example'),newer={...entitlement(true),generated_at:'2026-09-29T01:00:00Z'},older={...entitlement(),generated_at:'2026-09-29T00:00:00Z'};
    a.rememberEntitlements(newer);expect(a.rememberEntitlements(older)).toBe(newer);expect(await a.entitlements()).toBe(newer);
  });
});
