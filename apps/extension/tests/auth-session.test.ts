import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Api} from '../src/api';
import {API_BASE} from '../src/service';
import {RefreshUnavailable,SessionExpired} from '../src/auth/model';
import {sessionAuthorization} from '../src/auth/session';
import {authKey,readAuth,saveSession,signOut,subscribeAuth} from '../src/auth/storage';
import {stubAuthLocks,testSession} from './auth-fixture';
import 'fake-indexeddb/auto';

const endpoint='https://identity.example.test/token';
const renewable=()=>testSession({credential:{kind:'oidc',refreshToken:'refresh-one',tokenEndpoint:endpoint,clientId:'public-client',resource:'https://comics.nodelane.net/api'}});
const renewed=()=>Response.json({access_token:'new-access',refresh_token:'refresh-two',token_type:'Bearer',expires_in:3600});
const unauthorized=()=>Response.json({error:{code:'TOKEN_INVALID',message:'Expired'}},{status:401});
const bound=()=>new Api(API_BASE,'test-token',undefined,undefined,sessionAuthorization('test-session'));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
let entries:Map<string,string>;
let request:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  entries=new Map();stubAuthLocks();vi.stubGlobal('chrome',undefined);
  vi.stubGlobal('localStorage',{getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>entries.set(key,value),removeItem:(key:string)=>entries.delete(key)});
  request=vi.fn(async()=>{throw Error('Unexpected request');});vi.stubGlobal('fetch',request);
});
afterEach(()=>vi.unstubAllGlobals());

describe('shared renewable sessions',()=>{
  it('rejects incomplete session records instead of restoring old identities',async()=>{
    entries.set(authKey,JSON.stringify({token:'old-token',user:{id:'old'}}));
    expect(await readAuth()).toEqual({session:null,reason:'expired'});
    expect(request).not.toHaveBeenCalled();
  });
  it('stores extension credentials only in trusted chrome storage, without localStorage mirroring',async()=>{
    const saved:Record<string,unknown>={};const access=vi.fn();
    vi.stubGlobal('chrome',{storage:{local:{setAccessLevel:access,get:async(key:string)=>({[key]:saved[key]}),set:async(value:object)=>Object.assign(saved,value)}}});
    await saveSession(renewable());
    expect((await readAuth()).session?.credential).toMatchObject({refreshToken:'refresh-one'});
    expect(access).toHaveBeenCalledWith({accessLevel:'TRUSTED_CONTEXTS'});
    expect(entries.size).toBe(0);
  });
  it('persists Firefox credentials privately and broadcasts only a session marker',async()=>{
    const saved:Record<string,unknown>={};
    vi.stubGlobal('chrome',{storage:{local:{get:async(key:string)=>({[key]:saved[key]}),set:async(value:object)=>Object.assign(saved,value)}}});
    await saveSession(renewable());
    expect((await readAuth()).session?.credential).toMatchObject({refreshToken:'refresh-one'});
    expect(saved[authKey]).toMatchObject({session:{id:'test-session'}});
    expect(JSON.stringify(saved)).not.toMatch(/refresh-one|test-token|public-client/);
    expect(entries.size).toBe(0);
    await signOut('test-session');
    expect(await readAuth()).toEqual({session:null});
    expect(saved[authKey]).toMatchObject({session:null});
  });
  it('refreshes once for concurrent consumers and persists rotation before using the token',async()=>{
    await saveSession({...renewable(),refreshAt:Date.now()-1});
    request.mockResolvedValueOnce(renewed());
    const results=await Promise.all(Array.from({length:12},()=>sessionAuthorization('test-session').token()));
    expect(new Set(results)).toEqual(new Set(['new-access']));expect(request).toHaveBeenCalledOnce();
    const init=request.mock.calls[0][1] as RequestInit,body=init.body as URLSearchParams;
    expect(request.mock.calls[0][0]).toBe(endpoint);
    expect(Object.fromEntries(body)).toEqual({grant_type:'refresh_token',refresh_token:'refresh-one',client_id:'public-client',resource:'https://comics.nodelane.net/api'});
    expect(init).toMatchObject({credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});
    expect((await readAuth()).session).toMatchObject({token:'new-access',credential:{refreshToken:'refresh-two'}});
    expect((await readAuth()).session!.expiresAt).toBeGreaterThan(Date.now()+3500000);
  });
  it('accepts a protocol response that does not rotate the refresh token',async()=>{
    await saveSession({...renewable(),refreshAt:Date.now()-1});
    request.mockResolvedValueOnce(Response.json({access_token:'new-access',token_type:'Bearer',expires_in:3600}));
    await sessionAuthorization('test-session').token();
    expect((await readAuth()).session?.credential).toMatchObject({refreshToken:'refresh-one'});
  });
  it.each([429,503])('retains a still-valid session on temporary refresh HTTP %s and applies shared cooldown',async status=>{
    await saveSession({...renewable(),refreshAt:Date.now()-1});request.mockResolvedValueOnce(new Response('',{status}));
    expect(await sessionAuthorization('test-session').token()).toBe('test-token');
    expect(await sessionAuthorization('test-session').token()).toBe('test-token');
    expect(request).toHaveBeenCalledOnce();expect((await readAuth()).session?.retryAt).toBeGreaterThan(Date.now());
  });
  it('does not send an expired access token while offline or log the user out',async()=>{
    await saveSession({...renewable(),refreshAt:Date.now()-2000,expiresAt:Date.now()-1000});request.mockRejectedValue(new TypeError('offline'));
    await expect(bound().entitlements()).rejects.toBeInstanceOf(RefreshUnavailable);
    await expect(bound().entitlements()).rejects.toBeInstanceOf(RefreshUnavailable);
    expect(request).toHaveBeenCalledOnce();expect((await readAuth()).session).not.toBeNull();
  });
  it('clears revoked credentials and notifies subscribers only once',async()=>{
    await saveSession({...renewable(),refreshAt:Date.now()-1});request.mockResolvedValueOnce(Response.json({error:'invalid_grant',error_description:'secret text'},{status:400}));
    const changed=vi.fn(),unsubscribe=subscribeAuth(changed);
    try{
      const attempts=await Promise.allSettled([sessionAuthorization('test-session').token(),sessionAuthorization('test-session').token()]);
      expect(attempts.every(r=>r.status==='rejected'&&r.reason instanceof SessionExpired)).toBe(true);
      expect(await readAuth()).toEqual({session:null,reason:'expired'});expect(changed).toHaveBeenCalledOnce();
      expect(entries.get(authKey)).not.toContain('refresh-one');expect(request).toHaveBeenCalledOnce();
    }finally{unsubscribe();}
  });
  it.each([{access_token:'new',token_type:'Bearer'},{access_token:'new',token_type:'Bearer',expires_in:-1},{access_token:'new',token_type:'Bearer',expires_in:3600,refresh_token:''}])('fails closed on invalid token response %j',async tokens=>{
    await saveSession({...renewable(),refreshAt:Date.now()-1});request.mockResolvedValueOnce(Response.json(tokens));
    await expect(sessionAuthorization('test-session').token()).rejects.toBeInstanceOf(SessionExpired);
    expect((await readAuth()).session).toBeNull();
  });
  it.each(['logout','switch'] as const)('cannot resurrect a session after %s during refresh',async action=>{
    await saveSession({...renewable(),refreshAt:Date.now()-1});
    const started=deferred<void>(),response=deferred<Response>();request.mockImplementationOnce(()=>{started.resolve();return response.promise;});
    const pending=sessionAuthorization('test-session').token();const failed=expect(pending).rejects.toThrow();
    await started.promise;
    if(action==='logout')await signOut('test-session');else await saveSession(testSession({id:'new-login',token:'other-token',user:{id:'other',name:'Other',role:'reader'}}));
    response.resolve(renewed());await failed;
    expect((await readAuth()).session?.id).toBe(action==='logout'?undefined:'new-login');
  });
  it('expires development sessions without sending a refresh request',async()=>{
    await saveSession(testSession({refreshAt:Date.now()-2000,expiresAt:Date.now()-1000}));
    await expect(bound().entitlements()).rejects.toBeInstanceOf(SessionExpired);
    expect(request).not.toHaveBeenCalled();expect((await readAuth()).reason).toBe('expired');
  });
});

describe('authenticated API boundaries',()=>{
  it('recovers a 401 once, replaying the exact operation body and idempotency key',async()=>{
    await saveSession(renewable());request.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(renewed()).mockResolvedValueOnce(Response.json({ok:true}));
    const body=JSON.stringify({operation_key:'stable-operation'});
    expect(await bound().request('/operation',{method:'POST',body,headers:{'Idempotency-Key':'stable-key'}})).toEqual({ok:true});
    expect(request).toHaveBeenCalledTimes(3);
    for(const index of [0,2]){const init=request.mock.calls[index][1] as RequestInit;expect(init.body).toBe(body);expect(new Headers(init.headers).get('Idempotency-Key')).toBe('stable-key');}
    expect(new Headers(request.mock.calls[2][1].headers).get('Authorization')).toBe('Bearer new-access');
  });
  it('does not refresh again for a late 401 that used a replaced token',async()=>{
    await saveSession(renewable());request.mockResolvedValueOnce(renewed());
    await sessionAuthorization('test-session').token('test-token');
    expect(await sessionAuthorization('test-session').token('test-token')).toBe('new-access');expect(request).toHaveBeenCalledOnce();
  });
  it('ends the session after a second 401 and blocks subsequent requests',async()=>{
    await saveSession(renewable());request.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(renewed()).mockResolvedValueOnce(unauthorized());
    const api=bound();await expect(api.entitlements()).rejects.toBeInstanceOf(SessionExpired);
    await expect(api.entitlements()).rejects.toBeInstanceOf(SessionExpired);
    expect(request).toHaveBeenCalledTimes(3);expect(await readAuth()).toEqual({session:null,reason:'expired'});
  });
  it('does not clear the new account when an old account request returns 401',async()=>{
    await saveSession(renewable());const started=deferred<void>(),response=deferred<Response>();
    request.mockImplementationOnce(()=>{started.resolve();return response.promise;});
    const pending=bound().entitlements(),failed=expect(pending).rejects.toThrow('账户或服务已切换');await started.promise;
    await saveSession(testSession({id:'other-login',token:'other-token'}));response.resolve(unauthorized());await failed;
    expect((await readAuth()).session?.id).toBe('other-login');expect(request).toHaveBeenCalledOnce();
  });
  it('does not reinterpret business 403 as an authentication failure',async()=>{
    await saveSession(renewable());request.mockResolvedValueOnce(Response.json({error:{code:'FORBIDDEN'}},{status:403}));
    await expect(bound().entitlements()).rejects.toMatchObject({status:403});expect(request).toHaveBeenCalledOnce();expect((await readAuth()).session).not.toBeNull();
  });
  it('keeps the same session binding for the long-poll listener',async()=>{
    await saveSession(renewable());request.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(renewed()).mockResolvedValueOnce(Response.json({jobs:[]}));
    await bound().waitForTranslationChanges('1',new AbortController().signal);
    expect(new Headers(request.mock.calls[2][1].headers).get('Authorization')).toBe('Bearer new-access');
  });
  it('applies refresh to authenticated uploads',async()=>{
    await saveSession(renewable());request.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(renewed()).mockResolvedValueOnce(new Response('',{status:200}));
    await bound().uploadOriginal({id:'test-upload',url:API_BASE+'/upload',method:'PUT',headers:{},authorization_required:true,expires_at:new Date(Date.now()+60000).toISOString()},new Blob(['bytes']));
    expect(new Headers(request.mock.calls[2][1].headers).get('Authorization')).toBe('Bearer new-access');
  });
  it('refreshes signed image URLs without touching the login session',async()=>{
    await saveSession(renewable());vi.stubGlobal('createImageBitmap',async()=>({close(){}}));
    const access=()=>Response.json({url:'https://objects.example/image?signature=test',authorization_required:false,expires_at:'2099-01-01'});
    request.mockResolvedValueOnce(access()).mockResolvedValueOnce(new Response('',{status:401})).mockResolvedValueOnce(access()).mockResolvedValueOnce(new Response('bytes'));
    await bound().image('page');expect(request).toHaveBeenCalledTimes(4);
    expect(new Headers(request.mock.calls[1][1].headers).has('Authorization')).toBe(false);expect((await readAuth()).session?.token).toBe('test-token');
  });
});
