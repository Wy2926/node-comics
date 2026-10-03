import {describe,it,expect} from 'vitest';
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
 it.each(['queued','running','failed','cancelled','outcome_unknown','unknown_released','no_text','succeeded'] as const)('shares reader state for %s',status=>{const page={...target(0).page,translationScope:JSON.stringify([origin,'reader','overlay-v1']),jobs:[job(0,{status})]};const state=translationState({page,mode:'classic',language:'zh-Hans',userId:'reader',origin,active:true});if(status==='queued')expect(state?.kind).toBe('waiting');if(status==='unknown_released')expect(state?.retryable).toBe(false);});
 it('selects delivered classic results and rejects another account result',()=>{const page={...target(0).page,translationScope:JSON.stringify([origin,'reader','overlay-v1']),jobs:[job(0,{status:'succeeded'})]};expect(pageTranslation(page,'classic','zh-Hans',JSON.stringify([origin,'reader','overlay-v1'])).result?.result?.key).toBe('result-0');expect(pageTranslation(page,'classic','zh-Hans',JSON.stringify([origin,'other','overlay-v1'])).result).toBeUndefined();});
});
