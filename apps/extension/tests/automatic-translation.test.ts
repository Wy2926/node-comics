import 'fake-indexeddb/auto';
import {describe,it,expect} from 'vitest';
import {ReadingWindow,makeOperation,needsTranslation,targetKey} from '../src/translation/automatic';
import {job,origin,target} from './translation-fixture';
describe('local reading timing',()=>{
 it('refills all three lookahead slots on every forward page without restarting the prefetch delay',()=>{
  const window=new ReadingWindow();window.update([0,1,2,3].map(target),0);
  expect(window.ready(150).map(t=>t.page.pageIndex)).toEqual([0,1,2,3]);
  for(let current=1;current<=5;current++){
   const now=current*1000;window.update([current,current+1,current+2,current+3].map(target),now);
   expect(window.ready(now+80).map(t=>t.page.pageIndex)).toEqual([current,current+1,current+2,current+3]);
  }
  window.update([20,21,22].map(target),7000,true);
  expect(window.ready(7000).map(t=>t.page.pageIndex)).toEqual([20]);
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
  const page={...target(0).page,ownerId:'alice',apiOrigin:origin,jobs:[job(0,{status})]};expect(needsTranslation(page,'classic','zh-Hans','alice',origin)).toBe(false);
 });
 it('keeps account, page, mode and language operations separate and allows free reuse',async()=>{
  const a=await makeOperation(target(0),'alice','zh-Hans',async()=>undefined),b=await makeOperation(target(0),'bob','en',async()=>undefined);
  expect(a.id).not.toBe(b.id);expect(a.requestId).not.toBe(b.requestId);expect(a.request).not.toHaveProperty("max_quota_pages");
  expect(targetKey(crypto.randomUUID(),{...target(0).page,contentId:crypto.randomUUID(),id:"a".repeat(640)},"classic")).toMatch(/^[a-f0-9]{64}$/);
 });
});
