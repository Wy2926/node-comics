import {afterEach,describe,expect,it,vi} from 'vitest';
import {ApiError} from '../src/api';
import {autoConsentScope,readAutoConsents,saveAutoConsents,retryablePreparation} from '../src/reader/auto-consent';

afterEach(()=>vi.unstubAllGlobals());
describe('remembered automatic translation consent',()=>{
  it('persists confirmed entitlement and explicit off choice across reloads',()=>{
    const data=new Map<string,string>();
    vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)});
    const scope=autoConsentScope('alice','https://api.example','zh-Hans','classic');
    expect(readAutoConsents()).toEqual({});
    saveAutoConsents({[scope]:{version:'membership-pages-v1',quotaKind:'classic_daily'}});
    expect(readAutoConsents()).toEqual({[scope]:{version:'membership-pages-v1',quotaKind:'classic_daily'}});
    saveAutoConsents({});expect(readAutoConsents()).toEqual({});
  });
  it('isolates approval by account, service, language and translation mode',()=>{
    const original=autoConsentScope('alice','https://api.example','zh-Hans','classic');
    for(const scope of [autoConsentScope('bob','https://api.example','zh-Hans','classic'),autoConsentScope('alice','https://other.example','zh-Hans','classic'),autoConsentScope('alice','https://api.example','en','classic'),autoConsentScope('alice','https://api.example','zh-Hans','redraw')])expect(scope).not.toBe(original);
  });
  it('does not treat malformed/legacy settings as spending consent',()=>{
    for(const value of ['null','broken','{"x":{"unitCost":-1}}','{"autoTranslate":true}','{"x":{"unitCost":"2"}}']){
      vi.stubGlobal('localStorage',{getItem:()=>value});expect(readAutoConsents()).toEqual({});
    }
  });
  it('retries recoverable preparation but leaves permanent errors for action',()=>{
    for(const error of [new ApiError('offline'),new ApiError('busy','RATE_LIMIT',429),new ApiError('unavailable','ERROR',503),new ApiError('quota','DAILY_QUOTA_EXHAUSTED',409)])expect(retryablePreparation(error)).toBe(true);
    for(const error of [new ApiError('auth','UNAUTHORIZED',401),new ApiError('invalid','INVALID',422),new Error('missing file')])expect(retryablePreparation(error)).toBe(false);
  });
});
