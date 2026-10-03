import 'fake-indexeddb/auto';
import {describe,it,expect} from 'vitest';
import {ReadingProgress,ReadingWindow,needsTranslation,targetKey} from '../src/translation/automatic';
import {makeOperation} from '../src/translation/channels/adapters/nodelane/operations';
import {job,origin,target,originalInput} from './translation-fixture';
describe('local reading timing',()=>{
 it.each([[3000,900,1000],[1200,900,300],[901,900,1],[600,900,0]])('expands height %i in viewport %i after %i pixels, at most once per page',(height,viewport,threshold)=>{
  const progress=new ReadingProgress();
  if(threshold)expect(progress.update('first',-threshold+1,height,viewport)).toBe(4);
  expect(progress.update('first',-threshold,height,viewport)).toBe(5);
  expect(progress.update('first',0,height,viewport)).toBe(5);
  expect(progress.update('first',-height,height,viewport)).toBe(5);
  expect(progress.update('second',0,3000,viewport)).toBe(4);
 });
 it('does not consume the extra slot before entering the viewport or with unknown geometry',()=>{
  const progress=new ReadingProgress();expect(progress.update('first',900,500,900)).toBe(4);
  expect(progress.update('first',0,0,900)).toBe(4);expect(progress.update('first',24,500,900)).toBe(5);
 });
 it('adds the fifth slot without restarting warmup or moving the current target',()=>{
  const window=new ReadingWindow();window.update([0,1,2,3].map(target),0);
  window.update([0,1,2,3,4].map(target),50);expect(window.prefetchAt).toBe(150);
  expect(window.ready(149)).toHaveLength(1);expect(window.ready(150)).toHaveLength(5);
  window.update([1,2,3,4].map(target),1000);expect(window.ready(1080)).toHaveLength(4);
  window.update([1,2,3,4,5,6].map(target),1100);
  expect(window.ready(1100).map(t=>t.page.id)).toEqual([1,2,3,4,5].map(n=>`page-${n}`));
 });
 it('refills all three lookahead slots on every forward page without restarting the prefetch delay',()=>{
  const window=new ReadingWindow();window.update([0,1,2,3].map(target),0);
  expect(window.ready(150).map(t=>Number(t.page.id.replace('page-','')))).toEqual([0,1,2,3]);
  for(let current=1;current<=5;current++){
   const now=current*1000;window.update([current,current+1,current+2,current+3].map(target),now);
   expect(window.ready(now+80).map(t=>Number(t.page.id.replace('page-','')))).toEqual([current,current+1,current+2,current+3]);
  }
  window.update([20,21,22].map(target),7000,true);
  expect(window.ready(7000).map(t=>Number(t.page.id.replace('page-','')))).toEqual([20]);
 });
 it('starts immediately, prepares the next three at 150 ms, and ignores snapshot changes',()=>{
  const window=new ReadingWindow();window.update([0,1,2,3].map(target),0);
  expect(window.ready(0).map(t=>t.page.id)).toEqual(['page-0']);expect(window.ready(149)).toHaveLength(1);expect(window.ready(150)).toHaveLength(4);
  expect(window.update([0,1,2,3].map(target),160)).toBe(false);expect(window.ready(160)).toHaveLength(4);
 });
 it('coalesces scrolling at 80 ms with a 200 ms maximum and immediate explicit jumps',()=>{
  const window=new ReadingWindow();window.update([target(0)],0);
  window.update([target(1)],10);expect(window.ready(89)).toEqual([]);
  window.update([target(2)],60);window.update([target(3)],120);window.update([target(4)],180);
  expect(window.readyAt).toBe(210);expect(window.ready(210)[0].page.id).toBe('page-4');
  window.update([target(30)],220,true);expect(window.ready(220)[0].page.id).toBe('page-30');
 });
 it.each(['queued','running','failed','cancelled','outcome_unknown','unknown_released','no_text','succeeded'] as const)('never automatically regenerates %s',status=>{
  const scope=JSON.stringify([origin,'alice']),page={...target(0).page,translationScope:scope,jobs:[job(0,{status})]};expect(needsTranslation(page,'classic','zh-Hans',scope)).toBe(false);
 });
 it('keeps account, page, mode and language operations separate and allows free reuse',()=>{
  const a=makeOperation(target(0),'alice','zh-Hans',originalInput(0)),b=makeOperation(target(0),'bob','en',originalInput(0));
  expect(a.id).not.toBe(b.id);expect(a.requestId).not.toBe(b.requestId);expect(a.request).not.toHaveProperty("max_quota_pages");
  expect(targetKey(crypto.randomUUID(),{...target(0).page,contentId:crypto.randomUUID(),id:"a".repeat(640)},"classic")).toMatch(/^[a-f0-9]{64}$/);
 });
 it('constructs synchronously from prepared metadata without inferring input from the page',()=>{
  const prepared={...originalInput(1),profile:'short-edge-1800-webp90-v1' as const,width:600,height:900,sourceSha256:target(0).page.imageSha256};
  const record=makeOperation(target(0),'alice','en',prepared);
  expect(record.image).toEqual(prepared.image);expect(record.sourceSha256).toBe(prepared.sourceSha256);
  expect(record.inputProfile).toBe(prepared.profile);expect(record.inputSize).toEqual({width:600,height:900});
  expect(record.request).toEqual({image:prepared.image,mode:'classic',target_language:'en'});
 });
});
