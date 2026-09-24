import {describe,it,expect} from 'vitest';
import {readingImages} from '../src/inline/protocol';
import {comicSize,inlineImageSize} from '../src/sources';
import {translationState} from '../src/translation/state';
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
 it.each(['queued','running','failed','cancelled','outcome_unknown','unknown_released','no_text','succeeded'] as const)('shares reader state for %s',status=>{const page={...target(0).page,ownerId:'reader',apiOrigin:origin,jobs:[job(0,{status})]};const state=translationState({page,mode:'classic',language:'zh-Hans',userId:'reader',origin,active:true});if(status==='queued')expect(state?.kind).toBe('waiting');if(status==='unknown_released')expect(state?.retryable).toBe(false);});
 it('keeps classic fallback independent of a redraw attempt and rejects another account result',()=>{const page={...target(0).page,ownerId:'reader',apiOrigin:origin,jobs:[job(0,{status:'succeeded',output_asset_id:'output'})]};expect(pageTranslation(page,'classic','zh-Hans','reader',origin).result?.output_asset_id).toBe('output');expect(pageTranslation(page,'classic','zh-Hans','other',origin).result).toBeUndefined();});
});
