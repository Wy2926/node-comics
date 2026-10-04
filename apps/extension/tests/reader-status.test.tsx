import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Job,Page} from '../src/types';
import {emptyPage} from '../src/reader/model';
import {canRetryPage,displayTranslationState,pageTranslation,readingImage,type ImageLoadState} from '../src/reader/presentation';
import {ImageTranslationStatus} from '../src/reader/ImageTranslationStatus';
import {PageTranslationBar} from '../src/reader/PageTranslationBar';
import {translationNotice} from '../src/translation/notice';
import {translationState} from '../src/translation/channels/adapters/nodelane/state';
import type {LocalOperation} from '../src/translation/channels/adapters/nodelane/store';
import {needsTranslation,type TranslationState} from '../src/translation/automatic';

const origin='https://fixture.example';
const noop=()=>{};
it('offers originals and classic translation, respecting disabled channel capabilities',()=>{
 const controls=(modes?:'classic'[])=>renderToStaticMarkup(<PageTranslationBar selectedView="original" modes={modes} onView={noop} onFeedback={noop} translationLabel="Translate" onPanel={noop}/>);
 const available=controls();expect(available).toContain('aria-label="原图"');expect(available).toContain('aria-label="常规翻译"');
 const disabled=controls([]);expect(disabled).toContain('aria-label="原图"');expect(disabled).not.toContain('aria-label="常规翻译"');
});
it('keeps development diagnostics out of the reading toolbar',()=>{
 const html=renderToStaticMarkup(<PageTranslationBar selectedView="classic" allowsFeedback={false} onView={noop} onFeedback={noop} translationLabel="Translate" onPanel={noop}/>);
 expect(html).not.toContain('aria-label="翻译状态"');expect(html).not.toContain('aria-label="译图有问题"');
});
it('offers an explicit rerun only when it can run',()=>{
 const controls=(canRetry:boolean)=>renderToStaticMarkup(<PageTranslationBar selectedView="classic" allowsFeedback={false} onRetry={async()=>{}} canRetry={canRetry} onView={noop} onFeedback={noop} translationLabel="Translate" onPanel={noop}/>);
 const available=controls(true),disabled=controls(false);
 expect(available).toContain('data-reader-retry-trigger="true"');expect(available).toContain('aria-label="重新翻译此页"');
 expect(available).not.toContain('disabled');expect(available).not.toContain('aria-label="译图有问题"');
 expect(disabled).not.toContain('data-reader-retry-trigger');
 expect(available.indexOf('data-reader-retry-trigger')).toBeLessThan(available.indexOf('nc-page-versions'));
});
function statusMarkup(page:Page){
 function Status(){
  const state=translationState({page,mode:'classic',language:'zh-Hans',userId:'reader',origin,active:false});
  return <ImageTranslationStatus state={state} onRetry={noop} onUpgrade={noop} onLogin={noop}/>;
 }
 return renderToStaticMarkup(<Status/>);
}
function fixture(status:Job['status']):Page{
 const delivered:Job={id:'delivered',result:{key:'output',recoverable:true},mode:'classic',target_language:'zh-Hans',status:'succeeded',phase:'done',version:1,created_at:'2026-09-18T00:00:00Z',quota_pages:1,cache_hit:false};
 return {...emptyPage('page',800,1200),translationScope:JSON.stringify([origin,'reader','overlay-v1']),blobKey:'original',outputBlobs:{delivered:'translated'},jobs:[delivered,{...delivered,id:'retry',result:undefined,version:2,status,created_at:'2026-09-19T00:00:00Z'}]};
}
describe('explicit page rerun eligibility',()=>{
 const eligible=(page:Page,state?:TranslationState,scope=page.translationScope)=>canRetryPage(pageTranslation(page,'classic','zh-Hans',scope),state);
 it.each(['no_text','failed','cancelled'] as const)('allows explicit %s recovery without any translated image',status=>{
  const page=fixture(status);page.jobs=page.jobs.slice(1);page.outputBlobs={};
  expect(eligible(page)).toBe(true);
  expect(eligible(page,{kind:'error',message:'翻译失败'})).toBe(true);
 });
 it.each(['awaiting_upload','validating_upload','queued','running','outcome_unknown','unknown_released'] as const)('blocks %s even with an older cached result',status=>{
  expect(eligible(fixture(status))).toBe(false);
 });
 it('checks every pending task, not only the newest one',()=>{
  const page=fixture('no_text');page.jobs[0].status='running';
  expect(eligible(page)).toBe(false);
 });
 it('requires current language, account and result bytes for a successful rerun',()=>{
  const page=fixture('succeeded');page.jobs=page.jobs.slice(0,1);
  expect(eligible(page)).toBe(true);
  expect(eligible(page,undefined,'other-account')).toBe(false);
  expect(canRetryPage(pageTranslation(page,'classic','en',page.translationScope))).toBe(false);
  page.outputBlobs={};expect(eligible(page)).toBe(false);
  page.jobs=[];expect(eligible(page)).toBe(false);
 });
 it.each<TranslationState>([
  {kind:'waiting',message:'等待翻译'},
  {kind:'translating',message:'正在解码译图'},
  {kind:'login',message:'登录后自动翻译'},
  {kind:'upgrade',message:'升级权益'},
  {kind:'error',message:'结果待核实',retryable:false},
  {kind:'error',message:'译图加载失败',retryLabel:'点击重新加载'},
 ])('keeps $kind state recovery separate from model reruns',state=>{
  expect(eligible(fixture('no_text'),state)).toBe(false);
 });
});

describe('in-image retry status',()=>{
 it('leaves no-text terminal behavior unchanged with no in-image notice or automatic regeneration',()=>{
  const page=fixture('no_text');page.jobs=page.jobs.slice(1);page.outputBlobs={};
  expect(statusMarkup(page)).toBe('');
  expect(needsTranslation(page,'classic','zh-Hans',page.translationScope!)).toBe(false);
 });
 it.each(['awaiting_upload','validating_upload'] as const)('names the actual %s stage',status=>{
  const page=fixture(status),state=translationState({page,mode:'classic',language:'zh-Hans',userId:'reader',origin,active:true});
  expect(state?.message).toBe(status==='awaiting_upload'?'等待原图上传':'正在校验原图');
 });
 it('reports recovery when a failed upload left an older pending snapshot',()=>{
  const operation={requestId:'request-id',state:'uncertain',result:{state:'needs_input'},errorCode:'NETWORK_ERROR',retryAt:123} as LocalOperation;
  const state=translationState({page:fixture('awaiting_upload'),mode:'classic',language:'zh-Hans',userId:'reader',origin,active:true,operation});
  expect(state).toEqual({kind:'translating',message:'正在恢复翻译请求'});
 });
 it('explicitly names a new translation when local result bytes cannot be recovered',()=>{
  expect(translationNotice({kind:'error',message:'本地译图缓存已清理，请手动重新翻译。',retryAction:'translate'}).action).toBe('重新翻译');
 });
 it('replaces stale errors and pending tasks with the login action after sign-out',()=>{
  const page=fixture('running');page.translationError='旧账户下载失败';
  expect(translationState({page,mode:'classic',language:'zh-Hans',origin,active:true,error:'登录已过期'})).toEqual({kind:'login',message:'登录后自动翻译'});
  expect(translationState({page,mode:'classic',language:'zh-Hans',origin,active:false,error:'登录已过期'})).toBeUndefined();
 });
 it('exposes a failed rerun even while the previous translation remains readable',()=>{
  const page=fixture('failed');
  expect(readingImage(page,'classic',true,'zh-Hans',JSON.stringify([origin,'reader','overlay-v1'])).key).toBe('translated');
  const html=statusMarkup(page);
  expect(html).toContain('<button');expect(html).toContain('翻译失败 · 重试');expect(html).not.toContain('点击重新生成');
 });
 it.each(['outcome_unknown','unknown_released'] as const)('never presents regeneration for %s',status=>{
  const html=statusMarkup(fixture(status));
  expect(html).toContain('核实');expect(html).not.toContain('nc-image-translation-action');expect(html).not.toContain('点击重新生成');
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

describe('reader display state',()=>{
 const load=(phase:ImageLoadState['phase']):ImageLoadState=>({scope:'current',key:'translated',phase,retry:noop});
 it.each(['reading','decoding','displaying'] as const)('keeps feedback during %s without treating cached bytes as a displayed result',phase=>{
  const page=fixture('succeeded');page.jobs=page.jobs.slice(0,1);
  expect(statusMarkup(page)).toBe('');
  expect(displayTranslationState(undefined,load(phase),'translated')).toEqual({kind:'translating',message:phase==='reading'?'正在读取译图':'正在解码译图'});
  expect(needsTranslation(page,'classic','zh-Hans',page.translationScope!)).toBe(false);
 });
 it('clears loading only after DOM confirmation and ignores a different image identity',()=>{
  expect(displayTranslationState(undefined,load('ready'),'translated')).toBeUndefined();
  expect(displayTranslationState(undefined,load('decoding'),'other-result')).toBeUndefined();
 });
 it('exposes a reload error without converting it to a new translation action',()=>{
  const state=displayTranslationState(undefined,{...load('error'),error:'图片解码超时，请重试。'},'translated')!;
  expect(state.retryAction).toBeUndefined();expect(translationNotice(state).action).toBe('重试');
  expect(state).toMatchObject({kind:'error',retryLabel:'点击重新加载'});
 });
});
