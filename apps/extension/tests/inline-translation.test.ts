import 'fake-indexeddb/auto';
import {describe,it,expect,vi} from 'vitest';
import {Api,ApiError} from '../src/api';
import {emptyPage} from '../src/reader/model';
import {comicSize,readingImages} from '../src/inline/protocol';
import {translateInlinePage} from '../src/inline/translate';
import {readManifest,saveManifest} from '../src/translation/store';
import {translationState} from '../src/translation/state';
import type {Capabilities,Entitlements,FilePageMatch,Job,ModeQueue} from '../src/types';

const mode='classic',language='zh-Hans',userId='inline-test',origin='https://api.example';
const rights={plan:'free',modes:{classic:{allowed:true,unlimited:true,quota_kind:'classic_unlimited'}}} as Entitlements;
const caps={modes:[{id:mode,enabled:true,languages:[language]}]} as Capabilities;
function fixture(status?:Job['status']){
  const hash=crypto.randomUUID().replaceAll('-','').repeat(2);
  const page={...emptyPage('web',800,1200),id:hash,fileHash:hash,pageIndex:0,imageSha256:hash,imageByteSize:3,imageMime:'image/png',blobKey:hash};
  const api=new Api(origin);
  const job:Job={id:hash,input_asset_id:'asset',output_asset_id:status==='succeeded'?'output':null,status:status??'queued',mode,target_language:language,created_at:new Date().toISOString(),version:1,quota_pages:1,cache_hit:false,phase:'queued',image_sha256:hash};
  const match:FilePageMatch={file_hash:hash,page_index:0,asset:null,jobs:status?[job]:[]};
  vi.spyOn(api,'matchPages').mockImplementation(async()=>({items:[match]}));
  vi.spyOn(api,'queues').mockResolvedValue({items:[{mode,available_slots:3,in_flight:0,paused:false} as ModeQueue]});
  const submit=vi.spyOn(api,'submit').mockImplementation(async()=>{match.jobs=[job];return {id:'submission-'+hash,mode,target_language:language,items:[{client_item_id:hash,job}]};});
  const options={api,page,mode,language,userId,caps,rights,getBlob:async()=>new Blob(['png'],{type:'image/png'}),sessionId:'web-session'} as const;
  return {api,page,job,match,submit,options};
}
describe('in-page automatic translation',()=>{
  it('uses displayed geometry and excludes icons, thumbnails and banners',()=>{
    expect(comicSize(520,740)).toBe(true);expect(comicSize(300,8000)).toBe(true);expect(comicSize(800,400)).toBe(true);
    for(const size of [[80,80],[220,400],[300,200],[1200,150],[1600,400],[0,0],[NaN,900]])expect(comicSize(...size as [number,number])).toBe(false);
  });
  it('takes the on-screen image and next two without crawling unseen pages',()=>{
    const items=[-900,100,1100,2100,3100].map((top,id)=>({id,rect:{top,bottom:top+800,left:20,right:600}}));
    expect(readingImages(items,1200,900).map(i=>i.id)).toEqual([1,2,3]);
    expect(readingImages(items.slice(2),1200,900)).toEqual([]);
  });
  it.each(['queued','running','failed','cancelled','outcome_unknown','unknown_released','no_text','succeeded'] as const)('matches reader %s state without creating duplicate work',async status=>{
    const f=fixture(status),result=await translateInlinePage(f.options);
    expect(f.submit).not.toHaveBeenCalled();
    expect(result.state).toEqual(translationState({page:result.page,mode,language,userId,origin,active:true,caps,rights}));
    if(status==='succeeded')expect(result.result?.output_asset_id).toBe('output');
  });
  it('observes account-wide capacity across modes',async()=>{
    const f=fixture();vi.mocked(f.api.queues).mockResolvedValue({items:[{mode:'classic',available_slots:3,in_flight:1},{mode:'redraw',available_slots:0,in_flight:2}] as ModeQueue[]});
    const getBlob=vi.fn(f.options.getBlob);
    const result=await translateInlinePage({...f.options,getBlob});expect(f.submit).not.toHaveBeenCalled();expect(getBlob).not.toHaveBeenCalled();expect(result.state?.kind).toBe('waiting');
  });
  it('persists a single submission and recovers the same key after a lost response',async()=>{
    const f=fixture();f.submit.mockRejectedValue(new ApiError('lost response'));
    const first=await translateInlinePage(f.options);expect(first.manifest?.pending).toBeDefined();
    const manifest=(await readManifest(first.manifest!.id))!;manifest.retryAt=undefined;await saveManifest(manifest);
    await translateInlinePage({...f.options,retry:true});
    expect(f.submit).toHaveBeenCalledTimes(2);expect(f.submit.mock.calls[1]).toEqual(f.submit.mock.calls[0]);
  });
  it('permits a zero-quota reuse attempt then stops on a definitive quota rejection',async()=>{
    const f=fixture();f.submit.mockRejectedValue(new ApiError('no quota','DAILY_QUOTA_EXHAUSTED',409));
    const options={...f.options,rights:{...rights,modes:{...rights.modes,classic:{...rights.modes.classic,unlimited:false,quota:null}}}};
    const first=await translateInlinePage(options);expect(f.submit.mock.calls[0][0].max_quota_pages).toBe(0);expect(first.state?.kind).toBe('upgrade');
    await translateInlinePage(options);expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('retries failed work explicitly but never releases an uncertain request into a new job',async()=>{
    const failed=fixture('failed');await translateInlinePage({...failed.options,retry:true});
    expect(failed.submit.mock.calls[0][0]).toMatchObject({regenerate:true,rerun_job_id:failed.job.id});
    const unknown=fixture('unknown_released');await translateInlinePage({...unknown.options,retry:true});expect(unknown.submit).not.toHaveBeenCalled();
  });
  it('keeps a previous delivered image when a later attempt failed and allows explicit regeneration',async()=>{
    const f=fixture('failed');f.match.jobs.push({...f.job,id:'previous',status:'succeeded',output_asset_id:'previous-output',created_at:'2020-01-01'});
    const result=await translateInlinePage(f.options);expect(result.result?.id).toBe('previous');expect(result.state?.kind).toBe('error');
    await translateInlinePage({...f.options,retry:true});expect(f.submit).toHaveBeenCalledTimes(1);
  });
  it('does not adopt a result from a different account',async()=>{
    const f=fixture();f.page=Object.assign(f.page,{ownerId:'other',apiOrigin:origin,jobs:[{...f.job,status:'succeeded',output_asset_id:'private'}],outputBlobs:{[f.job.id]:'private'}});
    const result=await translateInlinePage(f.options);expect(result.result).toBeUndefined();expect(result.page.ownerId).toBe(userId);
  });
  it('keeps the classic delivery visible while redraw is waiting, like the reader',async()=>{
    const f=fixture('succeeded');vi.mocked(f.api.queues).mockResolvedValue({items:[{mode:'classic',available_slots:0,in_flight:3},{mode:'redraw',available_slots:3,in_flight:0}] as ModeQueue[]});
    const result=await translateInlinePage({...f.options,mode:'redraw',rights:{...rights,modes:{...rights.modes,redraw:rights.modes.classic}}});
    expect(result.result?.mode).toBe('classic');expect(result.result?.output_asset_id).toBe('output');expect(f.submit).not.toHaveBeenCalled();
  });
  it('removes stale display tokens when the server revokes a result',async()=>{
    const f=fixture('succeeded');Object.assign(f.page,{ownerId:userId,apiOrigin:origin,jobs:[f.job],outputBlobs:{[f.job.id]:'old-display-token'}});
    f.match.jobs=[{...f.job,output_asset_id:null,result_available:false,result_expired:true}];
    const result=await translateInlinePage(f.options);expect(result.result).toBeUndefined();expect(result.state?.message).toBe('译图已失效');
  });
});
