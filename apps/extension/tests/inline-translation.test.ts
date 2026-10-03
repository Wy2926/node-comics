import {describe,it,expect} from 'vitest';
import {readingImages} from '../src/inline/protocol';
import {comicSize,inlineImageSize} from '../src/sources';
import {translationState} from '../src/translation/channels/adapters/nodelane/state';
import {pageTranslation} from '../src/reader/presentation';
import {job,target,origin} from './translation-fixture';
describe('in-page translation',()=>{
 it('keeps generic heuristics separate from adapter-selected comic strips',()=>{
  const chapter='https://comix.to/title/nr83-sample/123-chapter-1';
  expect(inlineImageSize(760,60,chapter)).toBe(true);
  expect(inlineImageSize(760,60,'https://unknown.test/comic')).toBe(false);
  expect(inlineImageSize(760,60,'https://comix.to.evil.test/title/nr83-sample/123-chapter-1')).toBe(false);
  expect(inlineImageSize(760,1000,'https://comix.to/title/nr83-sample')).toBe(false);
  expect(inlineImageSize(760,1000,'https://comix.to/browse')).toBe(false);
  for(const size of [[0,100],[-1,100],[NaN,100],[Infinity,100]])expect(inlineImageSize(size[0],size[1],chapter)).toBe(false);
 });
 it('uses rendered image geometry and excludes icons and banners',()=>{expect(comicSize(520,740)).toBe(true);expect(comicSize(300,8000)).toBe(true);for(const size of [[80,80],[220,400],[300,200],[1200,150],[1600,400],[0,0],[NaN,900]])expect(comicSize(...size as [number,number])).toBe(false);});
 it('selects the current image and next three without discovering unseen pages',()=>{const items=[-900,100,1100,2100,3100].map((top,id)=>({id,rect:{top,bottom:top+800,left:20,right:600}}));expect(readingImages(items,1200,900).map(i=>i.id)).toEqual([1,2,3,4]);expect(readingImages(items.slice(2),1200,900)).toEqual([]);});
 it.each(['ltr','rtl'] as const)('includes both visible spread pages when DOM order differs from %s reading order',direction=>{
  const items=[{id:'left',rect:{top:20,bottom:820,left:0,right:500}},{id:'right',rect:{top:20,bottom:820,left:520,right:1020}},...Array.from({length:4},(_,i)=>({id:'next-'+i,rect:{top:1000+i*900,bottom:1800+i*900,left:0,right:500}}))];
  for(const ordered of [items,[items[1],items[0],...items.slice(2)]])expect(readingImages(ordered,1200,900,direction).map(i=>i.id)).toEqual(ordered.slice(0,4).map(i=>i.id));
 });
 it.each(['queued','running','failed','cancelled','outcome_unknown','unknown_released','no_text','succeeded'] as const)('shares reader state for %s',status=>{const page={...target(0).page,translationScope:JSON.stringify([origin,'reader','overlay-v1']),jobs:[job(0,{status})]};const state=translationState({page,mode:'classic',language:'zh-Hans',userId:'reader',origin,active:true});if(status==='queued')expect(state?.kind).toBe('waiting');if(status==='unknown_released')expect(state?.retryable).toBe(false);});
 it('selects delivered classic results and rejects another account result',()=>{const page={...target(0).page,translationScope:JSON.stringify([origin,'reader','overlay-v1']),jobs:[job(0,{status:'succeeded'})]};expect(pageTranslation(page,'classic','zh-Hans',JSON.stringify([origin,'reader','overlay-v1'])).result?.result?.key).toBe('result-0');expect(pageTranslation(page,'classic','zh-Hans',JSON.stringify([origin,'other','overlay-v1'])).result).toBeUndefined();});
});
