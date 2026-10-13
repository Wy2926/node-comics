import {describe,expect,it} from 'vitest';
import type {Capabilities,TranslationModelChoice} from '../../../../types';
import {entitlement,job,target} from '../../../../../tests/translation-fixture';
import {translationNotice} from '../../../notice';
import {translationState} from './state';
import {translationScope,type LocalOperation} from './store';

const origin='https://fixture.example',userId='reader';
const model:TranslationModelChoice={id:'selected',name:'Selected',requires_paid:false,available:true};
const caps:Capabilities={modes:[{id:'classic',label:'Classic',enabled:true}],languages:[{id:'zh-Hans',label:'Chinese'}],limits:{max_bytes:10000000,max_pixels:100000000,max_dimension:20000,max_translation_ids:32},entitlements:null,translation_models:[model]};
const input=()=>({page:target(0).page,mode:'classic' as const,language:'zh-Hans',modelId:model.id,userId,origin,active:true,caps,rights:entitlement()});

describe('official translation preparation and admission notices',()=>{
  it.each([undefined,model.id])('keeps model %s in preparation until both policy responses are ready',modelId=>{
    for(const policy of [{caps:undefined},{rights:undefined},{caps:{...caps,translation_models:undefined},rights:undefined}]){
      const state=translationState({...input(),modelId,...policy});
      expect(state).toEqual({kind:'waiting',message:'准备翻译…'});
      expect(translationNotice(state!).action).toBeUndefined();
    }
  });
  it('does not hide a failed policy request behind preparation',()=>{
    const state=translationState({...input(),rights:undefined,error:'连接失败'});
    expect(state).toEqual({kind:'error',message:'连接失败'});
    expect(translationNotice(state!).label).toBe('连接失败 · 重试');
  });
  it('keeps preparation distinct from server queueing and real admission backoff',()=>{
    expect(translationState(input())).toEqual({kind:'waiting',message:'准备翻译…'});
    const operation={state:'local'} as LocalOperation;
    expect(translationState({...input(),operation})?.message).toBe('准备翻译…');
    expect(translationState({...input(),operation:{...operation,state:'deferred'}})?.message).toBe('等待翻译');
    const queued=input();queued.page.jobs=[job(0)];queued.page.translationScope=translationScope(origin,userId);
    expect(translationState({...queued,rights:undefined})?.message).toBe('等待翻译');
  });
  it.each(['succeeded','no_text','running','failed'] as const)('does not replace an existing %s result or task with preparation',status=>{
    const value=input();value.page.jobs=[job(0,{status})];value.page.translationScope=translationScope(origin,userId);
    if(status==='succeeded')value.page.outputBlobs={'job-0':'cached-result'};
    const state=translationState({...value,rights:undefined});
    if(status==='succeeded'||status==='no_text')expect(state).toBeUndefined();
    else expect(state?.kind).toBe(status==='running'?'translating':'error');
  });
  it('does not show preparation for an inactive or signed-out image',()=>{
    expect(translationState({...input(),active:false,rights:undefined})).toBeUndefined();
    expect(translationState({...input(),userId:undefined,rights:undefined})?.kind).toBe('login');
  });
  it.each([
    ['not_allowed','upgrade','当前权益不支持 · 升级'],
    ['quota_exhausted','upgrade','额度不足 · 升级'],
    ['unavailable','error','暂不可用'],
    [undefined,'error','暂不可用'],
  ] as const)('reports model reason %s without mislabeling every denial as quota', (reason,kind,label)=>{
    const state=translationState({...input(),caps:{...caps,translation_models:[{...model,available:false,unavailable_reason:reason}]}})!;
    expect(state.kind).toBe(kind);expect(translationNotice(state).label).toBe(label);
    if(kind==='error')expect(state.retryable).toBe(false);
  });
  it('treats a removed model or empty catalog as unavailable, not exhausted quota',()=>{
    for(const translation_models of [[],undefined]){
      const state=translationState({...input(),caps:{...caps,translation_models}})!;
      expect(state.kind).toBe('error');expect(translationNotice(state).label).toBe('暂不可用');
    }
  });
  it('uses quota only when an automatic model actually reports exhausted quota',()=>{
    const locked={...model,id:'locked',available:false,unavailable_reason:'not_allowed' as const};
    const stateFor=(translation_models:TranslationModelChoice[])=>translationState({...input(),modelId:undefined,caps:{...caps,translation_models}})!;
    expect(translationNotice(stateFor([locked])).label).toBe('当前权益不支持 · 升级');
    expect(translationNotice(stateFor([locked,{...model,available:false,unavailable_reason:'quota_exhausted'}])).label).toBe('额度不足 · 升级');
    expect(translationNotice(stateFor([locked,{...model,available:false,unavailable_reason:'unavailable'}])).label).toBe('暂不可用');
    expect(stateFor([locked,model]).message).toBe('准备翻译…');
  });
  it('distinguishes mode permission from exhausted page quota',()=>{
    const rights=entitlement();rights.modes.classic.allowed=false;
    expect(translationNotice(translationState({...input(),rights})!).label).toBe('当前权益不支持 · 升级');
    rights.modes.classic={...rights.modes.classic,allowed:true,unlimited:false,quota:{id:'empty',kind:'classic_daily',granted:100,used:100,reserved:0,available:0,starts_at:'2026-01-01T00:00:00Z',resets_at:null,next_expiry_at:null,buckets:[]}};
    expect(translationNotice(translationState({...input(),rights})!).label).toBe('额度不足 · 升级');
  });
  it.each([
    ['DAILY_QUOTA_EXHAUSTED','额度不足 · 升级'],
    ['TRANSLATION_MODEL_NOT_ALLOWED','当前权益不支持 · 升级'],
  ])('preserves the confirmed %s rejection even during policy loading',(errorCode,label)=>{
    const operation={state:'blocked',errorCode} as LocalOperation;
    const state=translationState({...input(),rights:undefined,operation})!;
    expect(translationNotice(state).label).toBe(label);
  });
});
