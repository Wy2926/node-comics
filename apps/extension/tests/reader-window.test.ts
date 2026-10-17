import {describe,expect,it} from 'vitest';
import {chapterWindow,chapterResources,pageWindow,pageAtHeight,nextImagePages,type ChapterWindow} from '../src/reader/virtual-window';
import {pageFrame} from '../src/reader/geometry';
import type {ReadingEntry,Page} from '../src/types';

const chapter=(id:string,count:number):ReadingEntry=>({id,title:id,source:'local',sourceKey:id,pages:Array.from({length:count},(_,index)=>({id:`${id}-${index}`,name:`${index}`,width:800,height:1000+index,jobs:[],outputBlobs:{}} as Page)),generation:1,createdAt:0,updatedAt:0,pageId:`${id}-0`,relativeOffset:0,discoveryComplete:true});
describe('bounded reader geometry',()=>{
 it.each([{width:390,height:640},{width:1200,height:900},{width:1200,height:80}])('uses the full reading width without a hidden surface gutter in %j',viewport=>{
  const page={width:800,height:1200};
  for(const zoom of [50,100,200]){
   const frame=pageFrame(page,viewport,'width',zoom);
   expect(frame.width).toBe(viewport.width*zoom/100);
   expect(frame.width/frame.height).toBeCloseTo(page.width/page.height);
  }
 });
 it.each([{width:800,height:1200},{width:1600,height:900}])('fits single or continuous pages to at least one complete viewport axis without padding: %j',page=>{
  for(const viewport of [{width:390,height:640},{width:1200,height:900},{width:1200,height:80}]){
   const frame=pageFrame(page,viewport,'window');
   expect(frame.width).toBeLessThanOrEqual(viewport.width+1e-8);
   expect(frame.height).toBeLessThanOrEqual(viewport.height+1e-8);
   expect(Math.min(Math.abs(frame.width-viewport.width),Math.abs(frame.height-viewport.height))).toBeLessThan(1e-8);
   expect(frame.width/frame.height).toBeCloseTo(page.width/page.height);
  }
 });
 it('keeps both comparison panes readable on phones, using the existing horizontal canvas scroll',()=>{
  const page={width:800,height:1200},phone={width:390,height:640};
  const regular=pageFrame(page,phone,'width'),comparison=pageFrame(page,phone,'width',100,true);
  expect(comparison.width).toBe(regular.width*2);
  expect(comparison.height).toBe(regular.height);
  const desktop=pageFrame(page,{width:1200,height:900},'width',100,true);
  expect(desktop.width).toBe(1200);
 });
 it('retains the current page and fractional anchor when a phone rotates in comparison mode',()=>{
  const book=chapter('phone-book',50),index=25,relativeOffset=.42;
  for(const viewport of [{width:390,height:620},{width:800,height:240}]){
   const height=(page:Page)=>pageFrame(page,viewport,'width',100,true).height;
   const [window]=pageWindow([book],book.id,index,height);
   const top=window.offsets[index]+height(book.pages[index])*relativeOffset;
   expect(pageAtHeight(window.offsets,top)).toBe(index);
   expect((top-window.offsets[index])/height(book.pages[index])).toBeCloseTo(relativeOffset);
  }
 });
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

describe('shared reader prefetch ranges',()=>{
 const window=(copy:ReadingEntry,start:number,end:number):ChapterWindow=>({copy,start,end,before:0,after:0,offsets:[]});
 it('prepares two byte-only pages after the continuous eleven-page decoded window',()=>{
  const book=chapter('book',30),windows=pageWindow([book],book.id,0,p=>p.height);
  expect(windows[0].end).toBe(11);
  expect(nextImagePages(windows,'continuous').map(p=>p.id)).toEqual(['book-11','book-12']);
 });
 it('single mode only prepares the next page',()=>{
  const book=chapter('book',8);
  expect(nextImagePages([window(book,2,3)],'single').map(p=>p.id)).toEqual(['book-3']);
 });
 it.each(['single','double'] as const)('%s prepares metadata only in the last three pages of a complete chapter',layout=>{
  const current=chapter('current',20),next=chapter('next',0),stream=[current];
  expect(chapterResources(stream,current,16,next,layout)).toEqual([current]);
  expect(chapterResources(stream,current,17,next,layout)).toEqual([current,next]);
  expect(chapterResources(stream,current,19,undefined,layout)).toEqual([current]);
  const partial={...current,discoveryComplete:false},missing={...current,knownTotal:21};
  expect(chapterResources([partial],partial,19,next,layout)).toEqual([partial]);
  expect(chapterResources([missing],missing,19,next,layout)).toEqual([missing]);
 });
 it('continuous metadata retains only the existing three-chapter window',()=>{
  const sequence=Array.from({length:5},(_,i)=>chapter(String(i),20)),current=sequence[2],stream=chapterWindow(sequence,current);
  expect(chapterResources(stream,current,0,sequence[3],'continuous')).toBe(stream);
  expect(stream.map(c=>c.id)).toEqual(['1','2','3']);
 });
 it.each(['continuous','single','double'] as const)('%s crosses only a complete chapter boundary into the provided next opening',layout=>{
  const current=chapter('current',8),next=chapter('next',6);
  expect(nextImagePages([window(current,7,8)],layout,next).map(p=>p.id)).toEqual(layout==='continuous'?['next-0','next-1']:['next-0']);
  expect(nextImagePages([window({...current,discoveryComplete:false},7,8)],layout,next)).toEqual([]);
  expect(nextImagePages([window({...current,knownTotal:9},7,8)],layout,next)).toEqual([]);
  expect(nextImagePages([window(current,7,8)],layout,chapter('unreadable',0))).toEqual([]);
  expect(nextImagePages([window(current,7,8)],layout,current)).toEqual([]);
 });
 it('fills the continuous two-page byte budget across a boundary, but never mixes chapters into a spread',()=>{
  const current=chapter('current',8),next=chapter('next',6);
  expect(nextImagePages([window(current,5,7)],'continuous',next).map(p=>p.id)).toEqual(['current-7','next-0']);
  expect(nextImagePages([window(current,5,7)],'single',next).map(p=>p.id)).toEqual(['current-7']);
  expect(nextImagePages([window(current,5,7)],'double',next).map(p=>p.id)).toEqual(['current-7']);
  expect(nextImagePages([window({...current,discoveryComplete:false},5,7)],'continuous',next).map(p=>p.id)).toEqual(['current-7']);
 });
 it('only uses confirmed opening descriptors even if the next chapter is partial',()=>{
  const current=chapter('current',8),next={...chapter('next',1),discoveryComplete:false};
  expect(nextImagePages([window(current,7,8)],'continuous',next).map(p=>p.id)).toEqual(['next-0']);
 });
 it('double mode reuses cover, portrait pair, landscape and orphan grouping',()=>{
  const book=chapter('book',8);book.pages[3]={...book.pages[3],width:2000,height:1000};
  for(const [start,end,expected] of [[0,1,[1,2]],[1,3,[3]],[3,4,[4,5]],[4,6,[6,7]],[6,8,[]]] as const){
   expect(nextImagePages([window(book,start,end)],'double').map(p=>Number(p.name))).toEqual(expected);
  }
  expect(nextImagePages([window({...book,pages:book.pages.slice(0,7)},4,6)],'double').map(p=>p.id)).toEqual(['book-6']);
 });
 it('uses the last nonempty mounted chapter and does not guess a next chapter',()=>{
  const before=chapter('before',20),current=chapter('current',5),after=chapter('after',20);
  expect(nextImagePages([window(before,19,20),window(current,0,3),window(after,0,0)],'continuous').map(p=>p.id)).toEqual(['current-3','current-4']);
  expect(nextImagePages([window(current,3,5),window(after,0,0)],'continuous')).toEqual([]);
  expect(nextImagePages([],'single')).toEqual([]);
 });
 it('does not guess beyond a partial manifest and recalculates after actual dimensions arrive',()=>{
  const book={...chapter('book',4),discoveryComplete:false};
  expect(nextImagePages([window(book,3,4)],'single')).toEqual([]);
  expect(nextImagePages([window(book,0,1)],'double').map(p=>p.id)).toEqual(['book-1','book-2']);
  book.pages[1]={...book.pages[1],width:2000,height:1000};
  expect(nextImagePages([window(book,0,1)],'double').map(p=>p.id)).toEqual(['book-1']);
 });
});
