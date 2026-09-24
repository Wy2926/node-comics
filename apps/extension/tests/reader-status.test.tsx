import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Api} from '../src/api';
import type {Job,Page} from '../src/types';
import {emptyPage} from '../src/reader/model';
import {readingImage} from '../src/reader/presentation';
import {ImageTranslationStatus} from '../src/reader/ImageTranslationStatus';
import {useAutomaticTranslation} from '../src/translation/useAutomaticTranslation';
import {translationNotice} from '../src/translation/notice';
import {translationState} from '../src/translation/state';
import type {LocalOperation} from '../src/translation/store';

const origin='https://fixture.example';
const noop=()=>{};
function statusMarkup(page:Page){
 function Status(){
  const {stateFor}=useAutomaticTranslation({api:new Api(origin),userId:'reader',origin,copies:[],updateEntry:noop,language:'zh-Hans'});
  return <ImageTranslationStatus state={stateFor('copy',page,'classic')} onRetry={noop} onUpgrade={noop} onLogin={noop}/>;
 }
 return renderToStaticMarkup(<Status/>);
}
function fixture(status:Job['status']):Page{
 const delivered:Job={id:'delivered',input_asset_id:'input',output_asset_id:'output',mode:'classic',target_language:'zh-Hans',status:'succeeded',phase:'done',version:1,created_at:'2026-09-18T00:00:00Z',quota_pages:1,cache_hit:false};
 return {...emptyPage('page',800,1200),ownerId:'reader',apiOrigin:origin,blobKey:'original',outputBlobs:{delivered:'translated'},jobs:[delivered,{...delivered,id:'retry',output_asset_id:null,version:2,status,created_at:'2026-09-19T00:00:00Z'}]};
}
describe('in-image retry status',()=>{
 it('replaces stale errors and pending tasks with the login action after sign-out',()=>{
  const page=fixture('running');page.translationError='旧账户下载失败';
  expect(translationState({page,mode:'classic',language:'zh-Hans',origin,active:true,error:'登录已过期'})).toEqual({kind:'login',message:'登录后自动翻译'});
  expect(translationState({page,mode:'classic',language:'zh-Hans',origin,active:false,error:'登录已过期'})).toBeUndefined();
 });
 it('exposes a failed rerun even while the previous translation remains readable',()=>{
  const page=fixture('failed');
  expect(readingImage(page,'classic',true,'zh-Hans','reader',origin).key).toBe('translated');
  const html=statusMarkup(page);
  expect(html).toContain('<button');expect(html).toContain('翻译失败 · 重试');expect(html).not.toContain('点击重新生成');
 });
 it.each(['outcome_unknown','unknown_released'] as const)('never presents regeneration for %s',status=>{
  const html=statusMarkup(fixture(status));
  expect(html).toContain('核实');expect(html).not.toContain('<button');expect(html).not.toContain('点击重新生成');
 });
 it('offers reloading rather than regeneration when delivered bytes failed to download',()=>{
  const page=fixture('succeeded');page.jobs=page.jobs.slice(0,1);page.outputBlobs={};page.translationError='下载暂时失败';
  const html=statusMarkup(page);
  expect(html).toContain('加载失败 · 重试');expect(html).not.toContain('点击重新生成');
 });
 it('keeps long diagnostic text out of the visible label',()=>{
  const detail='暂时连接不到服务。请检查网络连接，原图仍可继续阅读。';
  expect(translationNotice({kind:'error',message:detail})).toEqual({message:'连接失败',action:'重试',label:'连接失败 · 重试',detail});
  const html=renderToStaticMarkup(<ImageTranslationStatus state={{kind:'error',message:detail}} onRetry={noop} onUpgrade={noop} onLogin={noop}/>);
  expect(html).toContain(`title="${detail}"`);expect(html.replace(/<[^>]*>/g,'')).toBe('连接失败重试');
 });
 it('shows a connection failure instead of silently waiting on a local retry plan',()=>{
  const operation:LocalOperation={id:'retry',requestId:'retry',scope:'reader',entryId:'copy',pageId:'page',state:'local',createdAt:0,mode:'classic',language:'zh-Hans',image:{sha256:'a'.repeat(64),byte_size:1,content_type:'image/png'},request:{retry_of:'previous'}};
  const state=translationState({page:fixture('failed'),mode:'classic',language:'zh-Hans',userId:'reader',origin,active:true,error:'连接失败',operation});
  // A cached previous image can remain visible while a new attempt waits.
  expect(state?.kind).toBe('waiting');
  const page=fixture('failed');page.outputBlobs={};
  expect(translationState({page,mode:'classic',language:'zh-Hans',userId:'reader',origin,active:true,error:'连接失败',operation})?.message).toBe('连接失败');
 });
});
