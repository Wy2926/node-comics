import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Api} from '../src/api';
import type {Job,Page} from '../src/types';
import {emptyPage} from '../src/reader/model';
import {readingImage} from '../src/reader/presentation';
import {ImageTranslationStatus} from '../src/reader/ImageTranslationStatus';
import {useAutomaticTranslation} from '../src/translation/useAutomaticTranslation';

const origin='https://fixture.example';
const noop=()=>{};
function statusMarkup(page:Page){
 function Status(){
  const {stateFor}=useAutomaticTranslation({api:new Api(origin),userId:'reader',origin,copies:[],updateCopy:noop,concurrency:1,language:'zh-Hans',refreshUsage:noop});
  return <ImageTranslationStatus state={stateFor('copy',page,'classic')} onRetry={noop} onUpgrade={noop} onLogin={noop}/>;
 }
 return renderToStaticMarkup(<Status/>);
}
function fixture(status:Job['status']):Page{
 const delivered:Job={id:'delivered',input_asset_id:'input',output_asset_id:'output',mode:'classic',target_language:'zh-Hans',status:'succeeded',phase:'done',version:1,created_at:'2026-09-18T00:00:00Z',quota_pages:1,cache_hit:false};
 return {...emptyPage('page',800,1200),ownerId:'reader',apiOrigin:origin,blobKey:'original',outputBlobs:{delivered:'translated'},jobs:[delivered,{...delivered,id:'retry',output_asset_id:null,version:2,status,created_at:'2026-09-19T00:00:00Z'}]};
}
describe('in-image retry status',()=>{
 it('exposes a failed rerun even while the previous translation remains readable',()=>{
  const page=fixture('failed');
  expect(readingImage(page,'classic',true,'zh-Hans','reader',origin).key).toBe('translated');
  const html=statusMarkup(page);
  expect(html).toContain('<button');expect(html).toContain('翻译失败 · 点击重新生成');
 });
 it.each(['outcome_unknown','unknown_released'] as const)('never presents regeneration for %s',status=>{
  const html=statusMarkup(fixture(status));
  expect(html).toContain('核实');expect(html).not.toContain('<button');expect(html).not.toContain('点击重新生成');
 });
 it('offers reloading rather than regeneration when delivered bytes failed to download',()=>{
  const page=fixture('succeeded');page.jobs=page.jobs.slice(0,1);page.outputBlobs={};page.translationError='下载暂时失败';
  const html=statusMarkup(page);
  expect(html).toContain('点击重新加载');expect(html).not.toContain('点击重新生成');
 });
});
