import {afterEach,describe,expect,it,vi} from 'vitest';
import {defaults,type Job,type Page} from '../src/types';
import {newestFirst,pageTranslation,latestResults} from '../src/reader/presentation';
import {emptyPage,makeChapter,restoreImported} from '../src/reader/model';
import {applyMatch,planTranslation,rerunSource,sourceKey} from '../src/reader/recovery';
import {settings} from '../src/reader/store';
const origin='https://api.example';
const job=(id:string,status:Job['status'],created:number,extra:Partial<Job>={}):Job=>({id,status,created_at:`2026-09-14T00:00:0${created}Z`,input_asset_id:'source',output_asset_id:status==='succeeded'?`result-${id}`:null,mode:'classic',target_language:'zh-Hans',phase:'queued',cost:1,version:created,cache_hit:false,...extra});
const page=(jobs:Job[]):Page=>({...emptyPage('page',800,1200),fileHash:'a'.repeat(64),pageIndex:0,ownerId:'alice',apiOrigin:origin,jobs,outputBlobs:{first:'local-first',second:'local-second'}});
afterEach(()=>vi.unstubAllGlobals());
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
  it('migrates old settings and never restores automatic spending',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({autoTranslate:true,autoLimit:2.5,appearance:'wrong',accentTheme:'wrong',textScale:0,language:'en'})});
    expect(settings()).toMatchObject({autoTranslate:false,autoLimit:2,appearance:'system',accentTheme:'sky',textScale:1,language:'en',autoShowTranslation:true});
  });
  it('reimport restores original bytes without losing ordering, results or position',()=>{
    const old=page([job('first','succeeded',1)]);const existing={...makeChapter('My renamed book',[old]),relativeOffset:.42,coverPageId:old.id};
    const imported=makeChapter('new filename',[{...old,id:'new-local-id',blobKey:'restored-original',jobs:[],outputBlobs:{}}]);
    const restored=restoreImported([existing],imported);
    expect(restored).toMatchObject({id:existing.id,title:existing.title,relativeOffset:.42,pageId:old.id,coverPageId:old.id});
    expect(restored.pages[0]).toMatchObject({id:old.id,blobKey:'restored-original',jobs:old.jobs,outputBlobs:old.outputBlobs});
  });
});
