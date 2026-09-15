import {describe,expect,it} from 'vitest';
import {attachCopy,emptyLibrary,makeCopy} from '../src/library/model';
import {emptyPage} from '../src/reader/model';
import {readingDirectory} from '../src/library/directory';
import {translationSummaries} from '../src/library/translations';
import {readingImage} from '../src/reader/presentation';
import type {Job} from '../src/types';
import {copyComplete,copySummary} from '../src/ui/library/shared';

const job=(id:string,extra:Partial<Job>={}):Job=>({id,input_asset_id:'input',output_asset_id:id+'-output',mode:'classic',target_language:'zh-Hans',status:'succeeded',phase:'done',cost:1,created_at:'2026-09-15T00:00:00Z',version:1,cache_hit:false,...extra});
const page=(jobs:Job[],outputBlobs:Record<string,string>={})=>({...emptyPage('page',800,1200),blobKey:'original',ownerId:'owner',apiOrigin:'https://api.example',jobs,outputBlobs});

describe('work directory',()=>{
 it('counts all four imported images even for a legacy snapshot with unknown source completeness',()=>{
  const state=emptyLibrary(),copy={...makeCopy('发现图片导入',Array.from({length:4},()=>page([job('translated')],{translated:'result'})),'网页图片','web:legacy-selection'),discoveryComplete:false,knownTotal:undefined};
  attachCopy(state,copy,{title:'四页漫画',kind:'chapter'});
  expect(readingDirectory(state,[copy],copy).entries[0]).toMatchObject({available:4,total:4,status:'可阅读'});
  expect(copyComplete(copy)).toBe(true);expect(copySummary(copy)).toBe('离线可读 · 4 页');
  expect(translationSummaries(copy,'owner','https://api.example')[0]).toMatchObject({total:4,local:4});
  copy.pages[0].blobKey='';expect(readingDirectory(state,[copy],copy).entries[0]).toMatchObject({available:3,total:4,status:'部分可读'});expect(copyComplete(copy)).toBe(false);
 });
 it('retains an unknown or larger total for an unfinished catalog acquisition',()=>{
  const state=emptyLibrary(),copy={...makeCopy('采集章节',[page([])]),sourceEntryId:'source-entry',discoveryComplete:false,knownTotal:undefined as number|undefined};
  attachCopy(state,copy,{title:'作品',kind:'chapter'});
  expect(readingDirectory(state,[copy],copy).entries[0]).toMatchObject({available:1,total:undefined,status:'部分可读'});
  copy.knownTotal=4;expect(readingDirectory(state,[copy],copy).entries[0]).toMatchObject({available:1,total:4,status:'部分可读'});
 });
 it('shows every content item despite different sources or versions and includes missing copies',()=>{
  const state=emptyLibrary(),first=makeCopy('第一话',[page([])],'source-a'),second=makeCopy('第二话',[],'source-b');
  const workId=attachCopy(state,first,{title:'作品',kind:'chapter'});
  attachCopy(state,second,{title:'作品',kind:'chapter',workId});second.versionId='other';second.sourceEntryId='source-2';second.discoveryComplete=false;
  state.chapters.push({...state.chapters[1],id:'missing',order:2,title:'第三话'});
  state.tasks.push({id:'failed',copyId:second.id,status:'failed',phase:'images',completed:0,total:5,error:'图片获取失败，请重试',updatedAt:0});
  const result=readingDirectory(state,[first,second],first);
  expect(result.entries).toHaveLength(3);expect(result.entries[0].current).toBe(true);
  expect(result.entries[1]).toMatchObject({copyId:second.id,status:'采集失败',error:'图片获取失败，请重试'});
  expect(result.entries[2]).toMatchObject({copyId:undefined,status:'未添加副本'});
 });
 it('keeps the current copy selected and exposes explicit page ranges for navigation',()=>{
  const state=emptyLibrary(),first=makeCopy('第一话',[page([])]),alternative=makeCopy('其它扫描',[page([])]);
  const workId=attachCopy(state,first,{title:'作品',kind:'chapter'});
  attachCopy(state,alternative,{title:'作品',kind:'chapter',workId,targetId:state.chapters[0].id});
  state.coverage[0].startPageId=first.pages[0].id;
  expect(readingDirectory(state,[alternative,first],first).entries[0]).toMatchObject({copyId:first.id,pageId:first.pages[0].id,current:true});
 });
 it('offers the known source directory for an individually imported chapter',()=>{
  const state=emptyLibrary(),copy=makeCopy('单话',[]);
  copy.sourceUrl='https://www.mangacopy.com/comic/sample/chapter/724f819b-5306-11ea-b7ea-024352452ce0';
  attachCopy(state,copy,{title:'作品',kind:'chapter'});
  expect(readingDirectory(state,[copy],copy)).toMatchObject({catalogUrl:'https://www.mangacopy.com/comic/sample',catalogCount:0});
  copy.sourceUrl='https://untrusted.example/comic/sample/chapter/724f819b-5306-11ea-b7ea-024352452ce0';
  expect(readingDirectory(state,[copy],copy).catalogUrl).toBeUndefined();
 });
});

describe('derived translation editions',()=>{
 it('groups mode and language, counts each page once and retains delivery during a rerun',()=>{
  const copy=makeCopy('漫画',[page([job('old'),job('new',{version:2}),job('rerun',{version:3,status:'running',output_asset_id:null})],{old:'old-blob',new:'new-blob'}),page([job('english',{target_language:'en'})]),page([job('redraw',{mode:'redraw'})]),page([job('no-text',{status:'no_text',output_asset_id:null})])]);
  const snapshot=JSON.stringify(copy);
  const results=translationSummaries(copy,'owner','https://api.example');
  expect(results).toHaveLength(3);
  expect(results.find(s=>s.mode==='classic'&&s.language==='zh-Hans')).toMatchObject({local:1,remote:0,pending:1,noText:1,total:4});
  expect(results.find(s=>s.language==='en')).toMatchObject({remote:1,local:0});
  expect(JSON.stringify(copy)).toBe(snapshot);
 });
 it('does not restore an older translation when the newest result expires',()=>{
  const copy=makeCopy('漫画',[page([job('old'),job('expired',{version:2,result_expired:true,output_asset_id:null})],{old:'old-blob'}),page([job('unavailable',{result_available:false})])]);
  expect(translationSummaries(copy,'owner','https://api.example')[0]).toMatchObject({expired:2,local:0,remote:0});
 });
 it('keeps downloaded results readable even when the remote asset expires',()=>{
  const copy=makeCopy('漫画',[page([job('local',{output_asset_id:null,result_expired:true})],{local:'saved'})]);
  expect(translationSummaries(copy,'owner','https://api.example')[0]).toMatchObject({local:1,expired:0});
 });
 it('isolates account and service without leaking edition labels or counts',()=>{
  const copy=makeCopy('漫画',[page([job('private')])]);
  expect(translationSummaries(copy)).toEqual([]);
  expect(translationSummaries(copy,'other','https://api.example')).toEqual([]);
  expect(translationSummaries(copy,'owner','https://other.example')).toEqual([]);
 });
 it('shows the original for missing pages of an explicit redraw edition',()=>{
  const p=page([job('classic')],{classic:'translated'});
  expect(readingImage(p,'redraw',true,'zh-Hans','owner','https://api.example',false)).toEqual({key:'original',job:undefined});
  expect(readingImage(p,'redraw',true,'zh-Hans','owner','https://api.example').key).toBe('translated');
 });
});
