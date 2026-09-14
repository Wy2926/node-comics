import {afterEach,describe,expect,it,vi} from 'vitest';
import {type Job,type Page} from '../src/types';
import {pageTranslation,latestResults,readingImage} from '../src/reader/presentation';
import {emptyPage} from '../src/reader/model';

import {applyMatch,planTranslation,rerunSource,sourceKey} from '../src/reader/recovery';
import {settings} from '../src/library/store';
const origin='https://api.example';
const job=(id:string,status:Job['status'],created:number,extra:Partial<Job>={}):Job=>({id,status,created_at:`2026-09-14T00:00:0${created}Z`,input_asset_id:'source',output_asset_id:status==='succeeded'?`result-${id}`:null,mode:'classic',target_language:'zh-Hans',phase:'queued',cost:1,version:created,cache_hit:false,...extra});
const page=(jobs:Job[]):Page=>({...emptyPage('page',800,1200),fileHash:'a'.repeat(64),pageIndex:0,ownerId:'alice',apiOrigin:origin,jobs,outputBlobs:{first:'local-first',second:'local-second'}});
afterEach(()=>vi.unstubAllGlobals());
describe('per-page redraw display',()=>{
  it.each(['queued','running','failed','outcome_unknown','cancelled'] as const)('keeps classic while redraw is %s',status=>{
    const p=page([job('first','succeeded',1),job('redraw',status,2,{mode:'redraw'})]);
    expect(readingImage(p,'redraw',true,'zh-Hans','alice',origin)).toMatchObject({key:'local-first',job:{id:'first',mode:'classic'}});
  });
  it('keeps classic before submission and until redraw bytes are downloaded',()=>{
    const p=page([job('first','succeeded',1)]);
    expect(readingImage(p,'redraw',true,'zh-Hans','alice',origin).job?.id).toBe('first');
    p.jobs.push(job('redraw','succeeded',2,{mode:'redraw'}));
    expect(readingImage(p,'redraw',true,'zh-Hans','alice',origin).job?.id).toBe('first');
    p.outputBlobs.redraw='local-redraw';
    expect(readingImage(p,'redraw',true,'zh-Hans','alice',origin).job?.id).toBe('redraw');
    expect(readingImage(p,'classic',true,'zh-Hans','alice',origin).job?.id).toBe('first');
  });
  it('honors explicit original viewing even after redraw finishes',()=>{
    const p={...page([job('first','succeeded',1),job('second','succeeded',2,{mode:'redraw'})]),blobKey:'original'};
    expect(readingImage(p,'redraw',false,'zh-Hans','alice',origin)).toEqual({key:'original',job:undefined});
  });
  it('never falls back across account, language, origin or an expired latest result',()=>{
    const p={...page([job('first','succeeded',1)]),blobKey:'original'};
    for(const [language,owner,api] of [['en','alice',origin],['zh-Hans','bob',origin],['zh-Hans','alice','https://other.example']])expect(readingImage(p,'redraw',true,language,owner,api)).toEqual({key:'original',job:undefined});
    p.jobs.push(job('expired','succeeded',2,{output_asset_id:null,result_expired:true}));
    expect(readingImage(p,'redraw',true,'zh-Hans','alice',origin)).toEqual({key:'original',job:undefined});
  });
});
describe('latest effect selection',()=>{
  it.each(['queued','running','failed','outcome_unknown'] as const)('retains delivered effect while newer attempt is %s',status=>{
    const result=pageTranslation(page([job('first','succeeded',1),job('new',status,2)]),'classic','zh-Hans','alice',origin);
    expect(result.result?.id).toBe('first');expect(result.latest?.id).toBe('new');expect(result.blobKey).toBe('local-first');
  });
  it('selects by request order even if an old worker completes later',()=>{
    const p=page([job('second','succeeded',2,{completed_at:'2026-09-14T01:00:00Z'}),job('first','succeeded',1,{completed_at:'2026-09-14T02:00:00Z'})]);
    expect(pageTranslation(p,'classic','zh-Hans','alice',origin).result?.id).toBe('second');
  });
  it('does not restore an old version when the newest delivered output expires',()=>{
    const p=page([job('first','succeeded',1),job('second','succeeded',2,{output_asset_id:null,result_expired:true})]);delete p.outputBlobs.second;
    expect(pageTranslation(p,'classic','zh-Hans','alice',origin)).toMatchObject({expired:true,ready:false,result:{id:'second'}});
    p.outputBlobs.second='same-latest-local-copy';expect(pageTranslation(p,'classic','zh-Hans','alice',origin)).toMatchObject({expired:false,ready:true,blobKey:'same-latest-local-copy'});
  });
  it('never crosses account, origin, mode or language',()=>{
    const p=page([job('first','succeeded',1)]);
    for(const args of [['redraw','zh-Hans','alice',origin],['classic','en','alice',origin],['classic','zh-Hans','bob',origin],['classic','zh-Hans','alice','https://other.example']] as const)expect(pageTranslation(p,args[0],args[1],args[2],args[3]).result).toBeUndefined();
  });
  it('downloads only one delivered effect for each mode and language',()=>{
    expect(latestResults([job('first','succeeded',1),job('second','succeeded',2),job('redraw','succeeded',1,{mode:'redraw'}),job('pending','running',3)]).map(j=>j.id)).toEqual(['second','redraw']);
  });
});
describe('display projection and submission',()=>{
  it('does not retranslate an existing effect after supplier configuration changes',()=>{
    const p=page([]);const match={file_hash:p.fileHash!,page_index:0,asset:{id:'new-source',width:800,height:1200,expires_at:'2099-01-01'},jobs:[],display_jobs:[job('first','succeeded',1)]};
    const restored=applyMatch(p,match,'alice',origin);const result={matches:new Map([[sourceKey(match),match]]),errors:new Map()};
    expect(planTranslation([restored],result,'classic','zh-Hans').selected).toEqual([]);
    expect(planTranslation([restored],result,'classic','zh-Hans',true).selected).toHaveLength(1);
    expect(rerunSource(restored,match,'classic','zh-Hans')).toMatchObject({jobId:'first',inputAssetId:'new-source'});
  });
  it.each(['queued','running','outcome_unknown'] as const)('blocks rerun while a fresh display lookup finds %s',status=>{
    const p=page([]);const match={file_hash:p.fileHash!,page_index:0,asset:null,jobs:[],display_jobs:[job('current',status,2)]};
    const result=planTranslation([p],{matches:new Map([[sourceKey(match),match]]),errors:new Map()},'classic','zh-Hans',true);
    expect(result.selected).toEqual([]);expect(result.failures).toHaveLength(1);
  });
});
describe('local preferences and original recovery',()=>{
  it('drops retired preferences without treating them as automatic consent',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({autoTranslate:true,autoLimit:2.5,appearance:'wrong',accentTheme:'wrong',textScale:0,language:'en'})});
    expect(settings()).not.toHaveProperty('autoTranslate');
    expect(settings()).not.toHaveProperty('autoLimit');
    expect(settings()).toMatchObject({autoAhead:10,appearance:'system',accentTheme:'sky',textScale:1,language:'en',autoShowTranslation:true});
  });

});
