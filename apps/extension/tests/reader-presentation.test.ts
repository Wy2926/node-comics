import {afterEach,describe,expect,it,vi} from 'vitest';
import {type Job,type Page} from '../src/types';
import {pageTranslation,latestResults,readingImage} from '../src/reader/presentation';
import {emptyPage} from '../src/reader/model';

import {needsTranslation} from '../src/translation/automatic';
import {settings} from '../src/comics/application/preferences';
const origin='https://api.example',scope=JSON.stringify([origin,'alice']);
const job=(id:string,status:Job['status'],created:number,extra:Partial<Job>={}):Job=>({id,status,created_at:`2026-09-14T00:00:0${created}Z`,input_asset_id:'source',output_asset_id:status==='succeeded'?`result-${id}`:null,result:status==='succeeded'?{key:`result-${id}`,recoverable:true}:undefined,mode:'classic',target_language:'zh-Hans',phase:'queued',quota_pages:1,version:created,cache_hit:false,...extra});
const page=(jobs:Job[]):Page=>({...emptyPage('page',800,1200),fileHash:'a'.repeat(64),pageIndex:0,translationScope:scope,jobs,outputBlobs:{first:'local-first',second:'local-second'}});
afterEach(()=>vi.unstubAllGlobals());
describe('per-page redraw display',()=>{
  it.each(['queued','running','failed','outcome_unknown','cancelled'] as const)('keeps classic while redraw is %s',status=>{
    const p=page([job('first','succeeded',1),job('redraw',status,2,{mode:'redraw'})]);
    expect(readingImage(p,'redraw',true,'zh-Hans',scope)).toMatchObject({key:'local-first',job:{id:'first',mode:'classic'}});
  });
  it('keeps classic before submission and until redraw bytes are downloaded',()=>{
    const p=page([job('first','succeeded',1)]);
    expect(readingImage(p,'redraw',true,'zh-Hans',scope).job?.id).toBe('first');
    p.jobs.push(job('redraw','succeeded',2,{mode:'redraw'}));
    expect(readingImage(p,'redraw',true,'zh-Hans',scope).job?.id).toBe('first');
    p.outputBlobs.redraw='local-redraw';
    expect(readingImage(p,'redraw',true,'zh-Hans',scope).job?.id).toBe('redraw');
    expect(readingImage(p,'classic',true,'zh-Hans',scope).job?.id).toBe('first');
  });
  it('honors explicit original viewing even after redraw finishes',()=>{
    const p={...page([job('first','succeeded',1),job('second','succeeded',2,{mode:'redraw'})]),blobKey:'original'};
    expect(readingImage(p,'redraw',false,'zh-Hans',scope)).toEqual({key:'original',job:undefined});
  });
  it('never falls back across account, language, origin or an expired latest result',()=>{
    const p={...page([job('first','succeeded',1)]),blobKey:'original'};
    for(const [language,key] of [['en',scope],['zh-Hans','other-channel'],['zh-Hans','other-revision']])expect(readingImage(p,'redraw',true,language,key)).toEqual({key:'original',job:undefined});
    p.jobs.push(job('expired','succeeded',2,{output_asset_id:null,result_expired:true}));
    expect(readingImage(p,'redraw',true,'zh-Hans',scope)).toEqual({key:'original',job:undefined});
  });
});
describe('latest effect selection',()=>{
  it('displays local delivered bytes without a NodeLane account or asset id',()=>{
    const local=page([job('first','succeeded',1,{output_asset_id:null,result:{key:'local-request',recoverable:false}})]);
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
    const p=page([job('first','succeeded',1),job('second','succeeded',2,{output_asset_id:null,result_expired:true})]);delete p.outputBlobs.second;
    expect(pageTranslation(p,'classic','zh-Hans',scope)).toMatchObject({expired:true,ready:false,result:{id:'second'}});
    p.outputBlobs.second='same-latest-local-copy';expect(pageTranslation(p,'classic','zh-Hans',scope)).toMatchObject({expired:false,ready:true,blobKey:'same-latest-local-copy'});
  });
  it('never crosses account, origin, mode or language',()=>{
    const p=page([job('first','succeeded',1)]);
    for(const args of [['redraw','zh-Hans',scope],['classic','en',scope],['classic','zh-Hans','other-channel'],['classic','zh-Hans','other-revision']] as const)expect(pageTranslation(p,args[0],args[1],args[2]).result).toBeUndefined();
  });
  it('downloads only one delivered effect for each mode and language',()=>{
    expect(latestResults([job('first','succeeded',1),job('second','succeeded',2),job('redraw','succeeded',1,{mode:'redraw'}),job('pending','running',3)]).map(j=>j.id)).toEqual(['second','redraw']);
  });
});
describe('display projection and submission',()=>{
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
