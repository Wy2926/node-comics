import type {ComicTitleTranslation} from '../../../api';
import {msg} from '../../../i18n/runtime';
import type {SourceSearchResults} from '../../../sources';
import {requestedTitleLanguage,resolveComicTitle,titleFailure,validateSearchQuery} from './title-resolver';
import type {ComicSearchDependencies,ComicSearchSnapshot,SearchFailure,SearchSeed,SearchSiteState} from './types';

export const COMIC_SEARCH_CONCURRENCY=3;
const sessionPrefix=()=>globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const comicSearchSourceKey=(sourceId:string,catalogId:string)=>JSON.stringify([sourceId,catalogId]);
type Job={key:string;cursor?:string;attempt:number;generation:number};
type RunningJob={job:Job;controller:AbortController};

function siteFailure(error:unknown,now:number):SearchFailure {
  const detail=error as {code?:string;retryAfter?:number;retryAfterSeconds?:number;status?:number};
  const seconds=detail?.retryAfter??detail?.retryAfterSeconds;
  const retryAt=typeof seconds==='number'&&seconds>0?now+seconds*1000:undefined;
  if(detail?.code==='SOURCE_SEARCH_PERMISSION_REQUIRED')return {kind:'permission',message:msg('网站访问权限已被浏览器关闭，请在扩展设置中允许访问所有网站后重试。')};
  if(detail?.code==='SOURCE_SEARCH_RATE_LIMITED'||detail?.status===429)return {kind:'rate-limit',message:msg('此网站暂时限制请求，请稍后重试。'),retryAt};
  if(detail?.code==='SOURCE_SEARCH_VERIFICATION_REQUIRED')return {kind:'verification',message:msg('请打开来源网站完成登录或验证，然后重试。')};
  if(detail?.code==='SOURCE_SEARCH_TIMEOUT')return {kind:'timeout',message:msg('此网站搜索超时，可以单独重试。')};
  if(detail?.code==='SOURCE_SEARCH_CURSOR_EXPIRED')return {kind:'invalid',message:msg('更多结果已过期，请重新查找。')};
  return {kind:'unavailable',message:msg('此网站暂时无法搜索，可以单独重试。'),retryAt};
}

/** Page-local state. No storage, import side effects, background jobs or image-translation queue. */
export class ComicSearchSession {
  private snapshot:ComicSearchSnapshot;
  private readonly listeners=new Set<()=>void>();
  private readonly titleCache=new Map<string,ComicTitleTranslation>();
  private readonly attempts=new Map<string,number>();
  private readonly backoffs=new Map<string,SearchFailure>();
  private readonly running=new Map<string,RunningJob>();
  private pending:Job[]=[];
  private nameController?:AbortController;
  private generation=0;
  private searchId?:string;
  private disposed=false;
  private readonly prefix=sessionPrefix();
  private readonly now:()=>number;

  constructor(readonly seed:SearchSeed,private readonly deps:ComicSearchDependencies,defaultLanguage:string){
    this.now=deps.now??Date.now;
    this.snapshot={sourceTitle:seed.title,requestedTitleLanguage:defaultLanguage||'zh',query:'',phase:'idle',titleState:'idle',results:[],revision:0,
      sites:deps.listSites().map(site=>({site,selected:true,status:'idle',resultCount:0,resultKeys:[]}))};
  }
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private emit(patch:Partial<ComicSearchSnapshot>){
    if(this.disposed)return;
    this.snapshot={...this.snapshot,...patch,revision:this.snapshot.revision+1};
    this.listeners.forEach(listener=>listener());
  }
  private patchSite(key:string,patch:Partial<SearchSiteState>){this.emit({sites:this.snapshot.sites.map(state=>state.site.key===key?{...state,...patch}:state)});}
  private current(key:string){return this.snapshot.sites.find(state=>state.site.key===key);}
  private invalidate(release:boolean){
    this.generation++;
    this.nameController?.abort();this.nameController=undefined;
    this.running.forEach(run=>run.controller.abort());this.running.clear();this.pending=[];
    if(release&&this.searchId){this.deps.release(this.searchId);this.searchId=undefined;}
  }
  private prepare(){
    this.invalidate(true);
    this.emit({phase:'idle',query:'',resolvedTitleLanguage:undefined,titleState:'idle',titleError:undefined,results:[],searchedAt:undefined,sites:this.snapshot.sites.map(state=>({...state,status:'idle',resultCount:0,resultKeys:[],nextCursor:undefined,requestCursor:undefined,error:undefined}))});
  }
  setSourceTitle(value:string){if(value===this.snapshot.sourceTitle)return;this.prepare();this.emit({sourceTitle:value});}
  setTargetLanguage(value:string){if(value===this.snapshot.requestedTitleLanguage)return;this.prepare();this.emit({requestedTitleLanguage:value});}
  setSelected(key:string,selected:boolean){const state=this.current(key);if(!state)return;this.prepare();this.patchSite(key,{selected});}
  private selected(){return this.snapshot.sites.filter(state=>state.selected);}
  private noSites(){if(this.selected().length)return false;this.emit({phase:'needs-query',titleError:{kind:'invalid',message:msg('请先选择至少一个可搜索的网站。')}});return true;}
  async searchWithTranslatedTitle(){
    if(this.snapshot.titleRetryAt&&this.snapshot.titleRetryAt>this.now())return;
    if(this.noSites())return;
    const title=this.snapshot.sourceTitle.trim();
    this.prepare();
    if(!title||[...title].length>60||/[\p{Cc}\p{Cf}]/u.test(title)){
      this.emit({phase:'needs-query',titleState:'error',titleError:{kind:'invalid',message:msg('漫画名称需为 1–60 个字符，且不能包含控制字符。')}});return;
    }
    const generation=this.generation,controller=new AbortController();this.nameController=controller;
    const language=requestedTitleLanguage(this.snapshot.requestedTitleLanguage),key=JSON.stringify([title,language]);
    this.emit({phase:'resolving-name',titleState:'resolving'});
    try{
      const result=this.titleCache.get(key)??await resolveComicTitle(()=>this.deps.translateTitle(title,language,controller.signal),controller.signal);
      if(this.disposed||generation!==this.generation)return;
      this.titleCache.set(key,result);
      this.nameController=undefined;
      if(!result.name){this.emit({phase:'needs-query',titleState:'missing',query:''});return;}
      this.emit({query:result.name,resolvedTitleLanguage:result.target_language??undefined,titleState:'resolved'});
      try{validateSearchQuery(result.name);}catch(error){this.emit({phase:'needs-query',titleError:titleFailure(error,this.now())});return;}
      this.beginSites(result.name.trim());
    }catch(error){if(this.disposed||generation!==this.generation)return;const failure=titleFailure(error,this.now());this.emit({phase:'needs-query',titleState:'error',titleError:failure,titleRetryAt:failure.retryAt});}
  }
  searchManual(value:string){
    if(this.noSites())return;
    let query:string;
    try{query=validateSearchQuery(value);}catch(error){this.emit({titleError:titleFailure(error,this.now())});return;}
    this.prepare();this.emit({query,titleState:'manual'});this.beginSites(query);
  }
  private beginSites(query:string){
    this.searchId=`${this.prefix}:${this.generation}`;
    this.emit({query,phase:'searching',searchedAt:this.now(),titleError:undefined});
    for(const state of this.selected()){
      const backoff=this.backoffs.get(state.site.key);
      if(backoff?.retryAt&&backoff.retryAt>this.now())this.patchSite(state.site.key,{status:'error',error:backoff});
      else this.enqueue(state.site.key,undefined);
    }
    this.pump();
  }
  private enqueue(key:string,cursor:string|undefined){
    const attempt=(this.attempts.get(key)??0)+1;this.attempts.set(key,attempt);
    this.pending=this.pending.filter(job=>job.key!==key);
    this.running.get(key)?.controller.abort();this.running.delete(key);
    this.pending.push({key,cursor,attempt,generation:this.generation});
    this.patchSite(key,{status:'queued',requestCursor:cursor,error:undefined});
  }
  private valid(job:Job){return !this.disposed&&job.generation===this.generation&&this.attempts.get(job.key)===job.attempt;}
  private pump(){
    if(this.disposed)return;
    while(this.running.size<COMIC_SEARCH_CONCURRENCY&&this.pending.length){
      const job=this.pending.shift()!;if(!this.valid(job))continue;
      const controller=new AbortController();this.running.set(job.key,{job,controller});void this.run(job,controller);
    }
    if(this.snapshot.phase==='searching'&&!this.running.size&&!this.pending.length)this.emit({phase:'settled'});
  }
  private async run(job:Job,controller:AbortController){
    const state=this.current(job.key);if(!state||!this.searchId)return;
    this.patchSite(job.key,{status:'running'});
    try{
      // The source runtime owns permission checks and the per-page deadline.
      const page=await this.deps.search(state.site.adapterId,{siteId:state.site.id,query:this.snapshot.query,...(job.cursor?{cursor:job.cursor}:{})},{sessionId:this.searchId,signal:controller.signal});
      if(!this.valid(job))return;
      this.appendPage(job,page);
    }catch(error){
      if(!this.valid(job))return;
      const failure=siteFailure(error,this.now());
      if(failure.retryAt)this.backoffs.set(job.key,failure);
      const expired=(error as {code?:string})?.code==='SOURCE_SEARCH_CURSOR_EXPIRED';
      this.patchSite(job.key,{status:'error',error:failure,...(expired?{nextCursor:undefined,requestCursor:undefined}:{})});
    }finally{
      const active=this.running.get(job.key);
      if(active?.job===job)this.running.delete(job.key);
      if(this.valid(job))this.pump();
    }
  }
  private appendPage(job:Job,page:SourceSearchResults){
    this.backoffs.delete(job.key);
    const result=[...this.snapshot.results],positions=new Map(result.map((hit,index)=>[hit.key,index]));
    for(const hit of page.items){
      const index=positions.get(hit.key);
      if(index===undefined){positions.set(hit.key,result.length);result.push(hit);}
      else{
        const first=result[index];
        // A verified mirror can enrich this card, but must never move its source/action destination.
        result[index]={...first,authors:first.authors?.length?first.authors:hit.authors,cover:first.cover??hit.cover,coverHit:first.cover?first.coverHit:hit.cover?hit:undefined,latestLabel:first.latestLabel??hit.latestLabel,
          contentLanguages:first.contentLanguages?.length?first.contentLanguages:hit.contentLanguages};
      }
    }
    const resultKeys=[...new Set([...this.current(job.key)!.resultKeys,...page.items.map(hit=>hit.key)])],resultCount=resultKeys.length;
    this.emit({results:result});
    this.patchSite(job.key,{status:resultCount?'ready':'empty',resultCount,resultKeys,nextCursor:page.nextCursor,requestCursor:undefined,error:undefined});
  }
  retrySite(key:string){
    const state=this.current(key);
    if(!state||!state.selected||!this.searchId||!this.snapshot.query||state.status==='running'||state.status==='queued'||state.error?.retryAt&&state.error.retryAt>this.now())return;
    this.emit({phase:'searching'});this.enqueue(key,state.requestCursor);this.pump();
  }
  loadMore(key:string){
    const state=this.current(key);
    if(!state?.nextCursor||!this.searchId||state.status==='running'||state.status==='queued'||state.error?.retryAt&&state.error.retryAt>this.now())return;
    this.emit({phase:'searching'});this.enqueue(key,state.nextCursor);this.pump();
  }
  stop(){
    if(this.snapshot.phase!=='searching'&&this.snapshot.phase!=='resolving-name')return;
    this.invalidate(false);
    this.emit({phase:'stopped',titleState:this.snapshot.titleState==='resolving'?'idle':this.snapshot.titleState,sites:this.snapshot.sites.map(state=>['queued','running'].includes(state.status)?{...state,status:'stopped'}:state)});
  }
  dispose(){this.invalidate(true);this.disposed=true;this.listeners.clear();}
}
