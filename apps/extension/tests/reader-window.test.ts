import {describe,expect,it} from 'vitest';
import {chapterWindow,pageWindow,pageAtHeight} from '../src/reader/virtual-window';
import type {ReadingCopy,Page} from '../src/types';

const chapter=(id:string,count:number):ReadingCopy=>({id,title:id,source:'local',sourceKey:id,pages:Array.from({length:count},(_,index)=>({id:`${id}-${index}`,name:`${index}`,width:800,height:1000+index,jobs:[],outputBlobs:{}} as Page)),manifestRevision:1,retention:'offline',createdAt:0,updatedAt:0,pageId:`${id}-0`,relativeOffset:0,discoveryComplete:true});
describe('bounded reader geometry',()=>{
 it('retains at most three chapters and eleven total page elements across thirty chapters',()=>{
  const sequence=Array.from({length:30},(_,index)=>chapter('chapter-'+index,100));
  for(let active=0;active<30;active++)for(const index of [0,1,50,98,99]){
   const stream=chapterWindow(sequence,sequence[active]);expect(stream.length).toBeLessThanOrEqual(3);
   const windows=pageWindow(stream,sequence[active].id,index,page=>page.height);
   expect(windows.reduce((count,item)=>count+item.end-item.start,0)).toBe(11);
   const current=windows.find(item=>item.copy.id===sequence[active].id)!;expect(current.start).toBeLessThanOrEqual(index);expect(current.end).toBeGreaterThan(index);
  }
 });
 it('preserves exact height when pages move between DOM and spacers, including unequal page sizes',()=>{
  const stream=[chapter('before',9),chapter('current',120),chapter('after',8)];
  for(const index of [0,5,60,119])for(const item of pageWindow(stream,'current',index,page=>page.height)){
   const mounted=item.copy.pages.slice(item.start,item.end).reduce((total,page)=>total+page.height,0);
   expect(item.before+mounted+item.after).toBe(item.copy.pages.reduce((total,page)=>total+page.height,0));
  }
 });
 it('locates scrollbar jumps into unmounted ranges without a page DOM node',()=>{
  const [window]=pageWindow([chapter('book',120)],'book',0,page=>page.height);
  expect(window.end).toBe(11);expect(pageAtHeight(window.offsets,window.offsets[99]+300)).toBe(99);
  expect(pageAtHeight(window.offsets,window.offsets[99])).toBe(99);
  expect(pageAtHeight(window.offsets,-20)).toBe(0);expect(pageAtHeight(window.offsets,Infinity)).toBe(119);expect(pageAtHeight([0],0)).toBe(-1);
 });
 it('keeps the same page and fractional anchor when measured dimensions change',()=>{
  const book=chapter('book',100),index=75,relativeOffset=.42;
  const old=pageWindow([book],book.id,index,page=>page.height)[0];
  const changed={...book,pages:book.pages.map((page,n)=>({...page,height:page.height*(n<=index?1.7:1)}))};
  const next=pageWindow([changed],book.id,index,page=>page.height)[0];
  const oldTop=old.offsets[index]+book.pages[index].height*relativeOffset;
  const nextTop=next.offsets[index]+changed.pages[index].height*relativeOffset;
  expect(pageAtHeight(old.offsets,oldTop)).toBe(index);expect(pageAtHeight(next.offsets,nextTop)).toBe(index);
  expect((nextTop-next.offsets[index])/changed.pages[index].height).toBeCloseTo(relativeOffset);
 });
 it('renders exactly one requested page in single mode, including first and last',()=>{
  const book=chapter('book',120);for(const index of [0,52,119]){const [window]=pageWindow([book],book.id,index,page=>page.height,1);expect([window.start,window.end]).toEqual([index,index+1]);}
 });
});
