import {describe,expect,it,vi} from 'vitest';
import {chapterWindow,chapterResources,chapterGeometry,pageWindow,pageAtHeight,nextImagePages,type ChapterWindow} from '../src/reader/virtual-window';
import {pageFrame,thumbnailRowHeight,thumbnailWindow} from '../src/reader/geometry';
import type {ReadingEntry,Page} from '../src/types';

const chapter=(id:string,count:number):ReadingEntry=>({id,title:id,source:'local',sourceKey:id,pages:Array.from({length:count},(_,index)=>({id:`${id}-${index}`,name:`${index}`,width:800,height:1000+index,jobs:[],outputBlobs:{}} as Page)),generation:1,createdAt:0,updatedAt:0,pageId:`${id}-0`,relativeOffset:0,discoveryComplete:true});
describe('bounded thumbnail directory',()=>{
 it('does not mount images for an empty or unmeasured directory',()=>{
  expect(thumbnailWindow(0,0,500)).toEqual({start:0,end:0});
  expect(thumbnailWindow(1000,0,0)).toEqual({start:0,end:0});
 });
 it('covers partial rows and keeps only one spare row on either side',()=>{
  const top=500*thumbnailRowHeight+30,height=400;
  const range=thumbnailWindow(1000,top,height);
  expect(range).toEqual({start:499,end:505});
  expect((range.start+1)*thumbnailRowHeight).toBeLessThanOrEqual(top);
  expect((range.end-1)*thumbnailRowHeight).toBeGreaterThanOrEqual(top+height);
  expect(thumbnailWindow(1000,top+5,height)).toEqual(range);
 });
 it('clamps overscroll and stale positions after a directory shrinks',()=>{
  expect(thumbnailWindow(16,-40,500)).toEqual({start:0,end:6});
  expect(thumbnailWindow(16,100000,500)).toEqual({start:10,end:16});
  expect(thumbnailWindow(2,100000,500)).toEqual({start:0,end:2});
 });
 it.each([120,1000,100000])('keeps every visible row covered throughout a %i-page directory',count=>{
  for(const height of [104,500,900])for(let step=0;step<=1000;step++){
   const top=step/1000*Math.max(0,count*thumbnailRowHeight-height),{start,end}=thumbnailWindow(count,top,height);
   expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeLessThanOrEqual(count);
   expect(start*thumbnailRowHeight).toBeLessThanOrEqual(top);
   expect(end*thumbnailRowHeight).toBeGreaterThanOrEqual(top+height);
   expect(end-start).toBeLessThanOrEqual(Math.ceil(height/thumbnailRowHeight)+3);
  }
 });
});
describe('bounded reader geometry',()=>{
 it('reuses all three thousand-page geometries across progress saves while exposing the latest chapter metadata',()=>{
  let copies=[chapter('before',1000),chapter('current',1000),chapter('after',1000)];
  const frame=vi.fn((page:Page)=>pageFrame(page,{width:1200,height:900},'width',50));
  let measured=chapterGeometry(copies,frame);const offsets=measured.map(chapter=>chapter.offsets);frame.mockClear();
  for(let n=0;n<50;n++){
   copies=copies.map(copy=>copy.id==='current'?{...copy,pageId:`current-${n}`,relativeOffset:.25,updatedAt:n}:copy);
   measured=chapterGeometry(copies,frame,measured);
   expect(measured.map(chapter=>chapter.copy)).toEqual(copies);
   measured.forEach((chapter,n)=>expect(chapter.offsets).toBe(offsets[n]));
  }
  expect(frame).not.toHaveBeenCalled();expect(measured[1].copy.pageId).toBe('current-49');
 });
 it('remeasures only replaced page lists and drops geometry that leaves the chapter window',()=>{
  const copies=[chapter('a',10),chapter('b',10),chapter('c',10)],frame=vi.fn((page:Page)=>({width:page.width,height:page.height}));
  const before=chapterGeometry(copies,frame);frame.mockClear();
  const changed={...copies[1],pages:copies[1].pages.map((page,n)=>n===0?{...page,height:page.height*2}:page)};
  const next=chapterGeometry([changed,copies[2],chapter('d',10)],frame,before);
  expect(frame).toHaveBeenCalledTimes(20);expect(next[0].offsets[1]).toBe(before[1].offsets[1]*2);expect(next[1].offsets).toBe(before[2].offsets);
  expect(next.map(chapter=>chapter.copy.id)).toEqual(['b','c','d']);
  frame.mockClear();chapterGeometry(copies,frame,next);expect(frame).toHaveBeenCalledTimes(20);
 });
 it('remeasures changed ordering, lengths and fresh descriptors without retaining stale source bindings',()=>{
  const copy=chapter('a',3),frame=vi.fn((page:Page)=>({width:page.width,height:page.height})),before=chapterGeometry([copy],frame);
  for(const pages of [[...copy.pages].reverse(),copy.pages.slice(1),copy.pages.map(page=>({...page,blobKey:'fresh-source'}))]){
   frame.mockClear();const current={...copy,pages,generation:2},after=chapterGeometry([current],frame,before);
   expect(frame).toHaveBeenCalledTimes(pages.length);expect(after[0].copy).toBe(current);
   expect(after[0].offsets[1]).toBe(pages[0].height);
  }
  expect(chapterGeometry([],frame,before)).toEqual([]);
 });
 it('reuses chapter offsets and widths across a thousand page-window shifts without measuring pages again',()=>{
  const copies=[chapter('before',1000),chapter('current',1000),chapter('after',1000)];
  copies[1].pages[600]={...copies[1].pages[600],width:1600};
  const frame=vi.fn((page:Page)=>pageFrame(page,{width:1200,height:900},'window'));
  const measured=chapterGeometry(copies,frame);
  expect(frame).toHaveBeenCalledTimes(3000);
  expect(measured[1].width).toBe(900);
  frame.mockClear();
  for(let index=0;index<1000;index++){
   const windows=pageWindow(measured,'current',index);
   expect(windows.reduce((count,window)=>count+window.end-window.start,0)).toBe(4);
   for(let n=0;n<windows.length;n++){
    expect(windows[n].offsets).toBe(measured[n].offsets);
    expect(windows[n].copy).toBe(copies[n]);
   }
  }
  expect(frame).not.toHaveBeenCalled();
 });
 it('rebuilds geometry when dimensions or sizing change, without mutating the previous layout',()=>{
  const book=chapter('book',20),viewport={width:1200,height:900};
  const before=chapterGeometry([book],page=>pageFrame(page,viewport,'width',50));
  const updated={...book,pages:book.pages.map(page=>({...page,height:page.height*2}))};
  const after=chapterGeometry([updated],page=>pageFrame(page,viewport,'width',100,true));
  expect(before[0].width).toBe(600);expect(after[0].width).toBe(1200);
  expect(after[0].offsets.at(-1)).toBe(before[0].offsets.at(-1)!*2);
  expect(pageWindow(after,'book',12)[0].copy).toBe(updated);
  expect(before[0].copy).toBe(book);
 });
 it('keeps empty chapters and minimum placeholder heights valid',()=>{
  const empty=chapter('empty',0),book=chapter('book',2);
  const measured=chapterGeometry([empty,book],()=>({width:0,height:0}));
  expect(measured[0]).toMatchObject({offsets:[0],width:0});
  expect(measured[1].offsets).toEqual([0,1,2]);
  expect(pageWindow(measured,'book',1).map(({start,end,before,after})=>({start,end,before,after}))).toEqual([
   {start:0,end:0,before:0,after:0},{start:1,end:2,before:1,after:0},
  ]);
 });
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
 it('locates the page after recalculating comparison geometry for each phone orientation',()=>{
  const book=chapter('phone-book',50),index=25,relativeOffset=.42;
  for(const viewport of [{width:390,height:620},{width:800,height:240}]){
   const frame=(page:Page)=>pageFrame(page,viewport,'width',100,true);
   const measured=chapterGeometry([book],frame);
   const [window]=pageWindow(measured,book.id,index);
   const top=window.offsets[index]+frame(book.pages[index]).height*relativeOffset;
   expect(pageAtHeight(window.offsets,top)).toBe(index);
  }
 });
 it('retains at most three chapters and four forward page elements across thirty chapters',()=>{
  const sequence=Array.from({length:30},(_,index)=>chapter('chapter-'+index,100));
  for(let active=0;active<30;active++){
   const stream=chapterWindow(sequence,sequence[active]);expect(stream.length).toBeLessThanOrEqual(3);
   const measured=chapterGeometry(stream,page=>page);
   for(const index of [0,1,50,98,99]){
    const windows=pageWindow(measured,sequence[active].id,index);
    expect(windows.reduce((count,item)=>count+item.end-item.start,0)).toBeLessThanOrEqual(4);
    const current=windows.find(item=>item.copy.id===sequence[active].id)!;expect(current.start).toBeLessThanOrEqual(index);expect(current.end).toBeGreaterThan(index);
   }
  }
 });
 it('preserves exact height when pages move between DOM and spacers, including unequal page sizes',()=>{
  const stream=[chapter('before',9),chapter('current',120),chapter('after',8)];
  const measured=chapterGeometry(stream,page=>page);
  for(const index of [0,5,60,119])for(const item of pageWindow(measured,'current',index)){
   const mounted=item.copy.pages.slice(item.start,item.end).reduce((total,page)=>total+page.height,0);
   expect(item.before+mounted+item.after).toBe(item.copy.pages.reduce((total,page)=>total+page.height,0));
  }
 });
 it('locates scrollbar jumps into unmounted ranges without a page DOM node',()=>{
  const measured=chapterGeometry([chapter('book',120)],page=>page);
  const [window]=pageWindow(measured,'book',0);
  expect(window.end).toBe(4);expect(pageAtHeight(window.offsets,window.offsets[99]+300)).toBe(99);
  expect(pageAtHeight(window.offsets,window.offsets[99])).toBe(99);
  expect(pageAtHeight(window.offsets,-20)).toBe(0);expect(pageAtHeight(window.offsets,Infinity)).toBe(119);expect(pageAtHeight([0],0)).toBe(-1);
 });
 it('locates the page after rebuilding geometry from changed image dimensions',()=>{
  const book=chapter('book',100),index=75,relativeOffset=.42;
  const old=pageWindow(chapterGeometry([book],page=>page),book.id,index)[0];
  const changed={...book,pages:book.pages.map((page,n)=>({...page,height:page.height*(n<=index?1.7:1)}))};
  const next=pageWindow(chapterGeometry([changed],page=>page),book.id,index)[0];
  const oldTop=old.offsets[index]+book.pages[index].height*relativeOffset;
  const nextTop=next.offsets[index]+changed.pages[index].height*relativeOffset;
  expect(pageAtHeight(old.offsets,oldTop)).toBe(index);expect(pageAtHeight(next.offsets,nextTop)).toBe(index);
 });
});

describe('shared reader prefetch ranges',()=>{
 const window=(copy:ReadingEntry,start:number,end:number):ChapterWindow=>({copy,start,end,before:0,after:0,offsets:[]});
 it.each([[0,0,4],[1,1,5],[3,3,7],[19,19,23],[28,28,30],[29,29,30]])('reads only the current page and at most three following pages at index %i', (index,start,end)=>{
  const book=chapter('book',30),windows=pageWindow(chapterGeometry([book],page=>page),book.id,index);
  expect(windows[0]).toMatchObject({start,end});
  expect(nextImagePages(windows).map(p=>Number(p.name))).toEqual(Array.from({length:Math.min(5,30-end)},(_,n)=>end+n));
 });
 it.each([{layout:'single',start:2,end:3},{layout:'double',start:1,end:3},{layout:'continuous',start:0,end:4}])('$layout predownloads five originals beyond every mounted page',({start,end})=>{
  const book=chapter('book',20);
  expect(nextImagePages([window(book,start,end)]).map(p=>Number(p.name))).toEqual([end,end+1,end+2,end+3,end+4]);
 });
 it.each(['single','double'] as const)('%s prepares next metadata when its five-page byte window can reach the chapter end',layout=>{
  const current=chapter('current',20),next=chapter('next',0),stream=[current],first=layout==='double'?14:15;
  expect(chapterResources(stream,current,first-1,next,layout)).toEqual([current]);
  expect(chapterResources(stream,current,first,next,layout)).toEqual([current,next]);
  expect(chapterResources(stream,current,19,undefined,layout)).toEqual([current]);
  for(const partial of [{...current,discoveryComplete:false},{...current,knownTotal:21}])expect(chapterResources([partial],partial,19,next,layout)).toEqual([partial]);
 });
 it('continuous metadata retains only the existing three-chapter window',()=>{
  const sequence=Array.from({length:5},(_,i)=>chapter(String(i),20)),current=sequence[2],stream=chapterWindow(sequence,current);
  expect(chapterResources(stream,current,0,sequence[3],'continuous')).toBe(stream);
  expect(stream.map(c=>c.id)).toEqual(['1','2','3']);
 });
 it('fills five byte slots from only the confirmed direct next chapter',()=>{
  const current=chapter('current',8),next=chapter('next',6);
  expect(nextImagePages([window(current,7,8)],next).map(p=>p.id)).toEqual(['next-0','next-1','next-2','next-3','next-4']);
  expect(nextImagePages([window(current,5,7)],next).map(p=>p.id)).toEqual(['current-7','next-0','next-1','next-2','next-3']);
  for(const partial of [{...current,discoveryComplete:false},{...current,knownTotal:9}])expect(nextImagePages([window(partial,5,7)],next).map(p=>p.id)).toEqual(['current-7']);
  expect(nextImagePages([window(current,7,8)],chapter('unreadable',0))).toEqual([]);
  expect(nextImagePages([window(current,7,8)],current)).toEqual([]);
 });
 it('only uses discovered opening descriptors when the next chapter is partial',()=>{
  const current=chapter('current',8),next={...chapter('next',1),discoveryComplete:false};
  expect(nextImagePages([window(current,7,8)],next).map(p=>p.id)).toEqual(['next-0']);
 });
 it('byte lookahead includes five pages across cover, portrait and landscape groups',()=>{
  const book=chapter('book',8);book.pages[3]={...book.pages[3],width:2000,height:1000};
  for(const [start,end,expected] of [[0,1,[1,2,3,4,5]],[1,3,[3,4,5,6,7]],[3,4,[4,5,6,7]],[4,6,[6,7]],[6,8,[]]] as const){
   expect(nextImagePages([window(book,start,end)]).map(p=>Number(p.name))).toEqual(expected);
  }
 });
 it('uses the last nonempty mounted chapter and does not guess a next chapter',()=>{
  const before=chapter('before',20),current=chapter('current',5),after=chapter('after',20);
  expect(nextImagePages([window(before,19,20),window(current,0,3),window(after,0,0)]).map(p=>p.id)).toEqual(['current-3','current-4']);
  expect(nextImagePages([window(current,3,5),window(after,0,0)])).toEqual([]);
  expect(nextImagePages([])).toEqual([]);
 });
 it('does not guess beyond a partial manifest or shrink lookahead when real dimensions arrive',()=>{
  const book={...chapter('book',4),discoveryComplete:false};
  expect(nextImagePages([window(book,3,4)])).toEqual([]);
  expect(nextImagePages([window(book,0,1)]).map(p=>p.id)).toEqual(['book-1','book-2','book-3']);
  book.pages[1]={...book.pages[1],width:2000,height:1000};
  expect(nextImagePages([window(book,0,1)]).map(p=>p.id)).toEqual(['book-1','book-2','book-3']);
 });
});
