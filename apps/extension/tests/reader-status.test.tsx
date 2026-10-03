import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Job,Page} from '../src/types';
import {emptyPage} from '../src/reader/model';
import {readingImage} from '../src/reader/presentation';
import {ImageTranslationStatus} from '../src/reader/ImageTranslationStatus';
import {PageTranslationBar} from '../src/reader/PageTranslationBar';
import {translationNotice} from '../src/translation/notice';
import {translationState} from '../src/translation/channels/adapters/nodelane/state';
import type {LocalOperation} from '../src/translation/channels/adapters/nodelane/store';

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
describe('in-image retry status',()=>{
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
