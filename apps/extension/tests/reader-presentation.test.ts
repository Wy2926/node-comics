import {afterEach,describe,expect,it,vi} from 'vitest';
import {type Job,type Page} from '../src/types';
import {pageTranslation,latestResults,readingImage,imagePrefetchReady,canRetryPage,type ImageLoadState} from '../src/reader/presentation';
import {emptyPage} from '../src/reader/model';

import {needsTranslation} from '../src/translation/automatic';
import {settings} from '../src/comics/application/preferences';
const origin='https://api.example',scope=JSON.stringify([origin,'alice']);
const job=(id:string,status:Job['status'],created:number,extra:Partial<Job>={}):Job=>({id,status,created_at:`2026-09-14T00:00:0${created}Z`,result:status==='succeeded'?{key:`result-${id}`,recoverable:true}:undefined,mode:'classic',target_language:'zh-Hans',phase:'queued',quota_pages:1,version:created,cache_hit:false,...extra});
const page=(jobs:Job[]):Page=>({...emptyPage('page',800,1200),translationScope:scope,jobs,outputBlobs:{first:'local-first',second:'local-second'}});
const noText=()=>job('no-text','no_text',3,{result:{key:'no-text',recoverable:true},result_available:true,
  delivery:{kind:'no_text',representation:'original',normalization_version:1,input_sha256:'a'.repeat(64),width:800,height:1200}});
afterEach(()=>vi.unstubAllGlobals());
describe('source-only prefetch readiness',()=>{
  const load=(changes:Partial<ImageLoadState>={}):ImageLoadState=>({scope:'current-page',key:'result:translation',phase:'reading',retry:()=>{},...changes});
  it('can prefetch while the translation is pending once the original lease is acquired',()=>{
    expect(imagePrefetchReady('current-page',undefined,load({originalSettled:true}))).toBe(true);
    expect(imagePrefetchReady('current-page',{scope:'current-page'},load())).toBe(true);
  });
  it('allows an independent original failure without waiting for the translated image',()=>{
    expect(imagePrefetchReady('current-page',undefined,load({phase:'reading',originalSettled:true}))).toBe(true);
  });
  it('does not mistake a translated-image failure or ready flag for original lease handoff',()=>{
    for(const phase of ['reading','decoding','displaying','ready','error'] as const)
      expect(imagePrefetchReady('current-page',undefined,load({phase,originalSettled:false}))).toBe(false);
  });
  it('rejects pixels and source readiness from an old content or authorization scope',()=>{
    expect(imagePrefetchReady('new-page',{scope:'current-page'},load({originalSettled:true}))).toBe(false);
    expect(imagePrefetchReady('new-page',undefined,undefined)).toBe(false);
    expect(imagePrefetchReady('new-page',{scope:'new-page'},load({originalSettled:true}))).toBe(true);
  });
});
describe('per-page display',()=>{
  it('makes a confirmed unchanged original eligible for enhancement without materializing a translation',()=>{
    const original=noText(),p={...page([original]),blobKey:'original'};
    expect(readingImage(p,'classic',true,'zh-Hans',scope)).toEqual({key:'original',job:undefined,originalResult:original});
    expect(readingImage(p,'classic',false,'zh-Hans',scope)).toEqual({key:'original',job:undefined});
  });
  it('does not treat pending, failed, revoked or other-scope no-text results as enhanceable translations',()=>{
    const original=noText(),p={...page([original]),blobKey:'original'};
    for(const extra of [{status:'running'},{status:'failed'},{result_expired:true},{result_available:false},{result:undefined},{delivery:undefined}] as Partial<Job>[])
      expect(readingImage({...p,jobs:[{...original,...extra}]},'classic',true,'zh-Hans',scope).originalResult).toBeUndefined();
    for(const [language,key] of [['en',scope],['zh-Hans','another-account']])
      expect(readingImage(p,'classic',true,language,key).originalResult).toBeUndefined();
  });
  it('honors explicit original viewing even after translation finishes',()=>{
    const p={...page([job('first','succeeded',1)]),blobKey:'original'};
    expect(readingImage(p,'classic',false,'zh-Hans',scope)).toEqual({key:'original',job:undefined});
  });
  it('never falls back across account, language, origin or an expired latest result',()=>{
    const p={...page([job('first','succeeded',1)]),blobKey:'original'};
    for(const [language,key] of [['en',scope],['zh-Hans','other-channel'],['zh-Hans','other-revision']])expect(readingImage(p,'classic',true,language,key)).toEqual({key:'original',job:undefined});
    p.jobs.push(job('expired','succeeded',2,{result_expired:true}));
    expect(readingImage(p,'classic',true,'zh-Hans',scope)).toEqual({key:'original',job:undefined});
  });
});
describe('latest effect selection',()=>{
  it('lets a newer no-text result replace an old translation without downloading that old version',()=>{
    const original=noText(),p={...page([job('first','succeeded',1),original,job('next','running',4)]),blobKey:'original'};
    expect(readingImage(p,'classic',true,'zh-Hans',scope)).toEqual({key:'original',job:undefined,originalResult:original});
    expect(latestResults(p.jobs)).toEqual([]);
    original.result_expired=true;
    expect(readingImage(p,'classic',true,'zh-Hans',scope)).toEqual({key:'original',job:undefined});
  });
  it('displays local delivered bytes without a NodeLane account or asset id',()=>{
    const local=page([job('first','succeeded',1,{result:{key:'local-request',recoverable:false}})]);
    expect(pageTranslation(local,'classic','zh-Hans',scope)).toMatchObject({ready:true,expired:false});
    expect(readingImage(local,'classic',true,'zh-Hans',scope)).toMatchObject({key:'local-first'});
  });
  it.each(['queued','running','failed','outcome_unknown'] as const)('retains delivered effect while newer attempt is %s',status=>{
    const result=pageTranslation(page([job('first','succeeded',1),job('new',status,2)]),'classic','zh-Hans',scope);
    expect(result.result?.id).toBe('first');expect(result.latest?.id).toBe('new');expect(result.blobKey).toBe('local-first');
  });
  it('selects by request order even if an old worker completes later',()=>{
    const p=page([job('second','succeeded',2,{completed_at:'2026-09-14T01:00:00Z'}),job('first','succeeded',1,{completed_at:'2026-09-14T02:00:00Z'})]);
    expect(pageTranslation(p,'classic','zh-Hans',scope).result?.id).toBe('second');
  });
  it('does not restore an old version when the newest delivered output expires',()=>{
    const p=page([job('first','succeeded',1),job('second','succeeded',2,{result_expired:true})]);delete p.outputBlobs.second;
    expect(pageTranslation(p,'classic','zh-Hans',scope)).toMatchObject({expired:true,ready:false,result:{id:'second'}});
    p.outputBlobs.second='same-latest-local-copy';expect(pageTranslation(p,'classic','zh-Hans',scope)).toMatchObject({expired:false,ready:true,blobKey:'same-latest-local-copy'});
  });
  it('never crosses account, origin or language',()=>{
    const p=page([job('first','succeeded',1)]);
    for(const args of [['classic','en',scope],['classic','zh-Hans','other-channel'],['classic','zh-Hans','other-revision']] as const)expect(pageTranslation(p,args[0],args[1],args[2]).result).toBeUndefined();
  });
  it('downloads only one delivered effect for each language',()=>{
    expect(latestResults([job('first','succeeded',1),job('second','succeeded',2),job('english','succeeded',1,{target_language:'en'}),job('pending','running',3)]).map(j=>j.id)).toEqual(['second','english']);
  });
});
describe('display projection and submission',()=>{
  it('expired server results require an explicit rerun and keep local images readable',()=>{
    const p=page([job('expired','succeeded',1,{result:undefined,result_expired:true,error:{code:'RESULT_EXPIRED',message:'expired'}})]);
    expect(needsTranslation(p,'classic','zh-Hans',scope)).toBe(false);
    expect(canRetryPage(pageTranslation(p,'classic','zh-Hans',scope))).toBe(true);
    p.outputBlobs.expired='local-copy';
    expect(readingImage(p,'classic',true,'zh-Hans',scope).key).toBe('local-copy');
  });
  it('does not retranslate an existing effect after supplier configuration changes',()=>{
    const restored=page([job('first','succeeded',1)]);
    expect(needsTranslation(restored,'classic','zh-Hans',scope)).toBe(false);
  });
  it.each(['queued','running','outcome_unknown'] as const)('blocks rerun while a fresh display lookup finds %s',status=>{
    const restored=page([job('current',status,2)]);
    expect(needsTranslation(restored,'classic','zh-Hans',scope)).toBe(false);
  });
});
describe('local preferences and original recovery',()=>{
  it('drops retired preferences without treating them as automatic consent',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({autoTranslate:true,autoLimit:2.5,appearance:'wrong',accentTheme:'wrong',textScale:0,language:'en'})});
    expect(settings()).not.toHaveProperty('autoTranslate');expect(settings()).not.toHaveProperty('autoShowTranslation');
    expect(settings()).not.toHaveProperty('autoLimit');
    expect(settings()).toMatchObject({appearance:'system',accentTheme:'sky',textScale:1,language:'en'});
  });

});
