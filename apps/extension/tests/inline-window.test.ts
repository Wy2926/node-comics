import {describe,it,expect} from 'vitest';
import {readingBatch,readingImages,retainedImages} from '../src/inline/window';

const slice=(id:string,left:number,top=0)=>({id,rect:{left,right:left+500,top,bottom:top+300}});
const page=(id:string,left:number)=>[0,300,600].map((top,n)=>slice(`${id}-${n}`,left,top));
const ids=(items:Iterable<{id:string}>)=>[...items].map(i=>i.id);

describe('inline reading surface',()=>{
  it.each(['ltr','rtl'] as const)('selects every visible slice in %s order despite interleaved offscreen DOM nodes',direction=>{
    const left=page('left',100),right=page('right',600),away=page('away',-1500);
    const expected=[0,1,2].flatMap(n=>direction==='ltr'?[`left-${n}`,`right-${n}`]:[`right-${n}`,`left-${n}`]);
    for(const items of [[...left,...away,...right],[...right,...away,...left],[...left,...away,...right].reverse()]){
      expect(ids(readingImages(items,1200,900,direction))).toEqual(expected);
      const retained=retainedImages(items,1200,900);
      expect([...left,...right].every(i=>retained.has(i))).toBe(true);
    }
  });
  it.each(['ltr','rtl'] as const)('prefetches spatially forward horizontal pages rather than the DOM tail (%s)',direction=>{
    const current=slice('current',350),left=slice('left',-500),right=slice('right',1200);
    expect(ids(readingImages([left,current,right],1200,900,direction))).toEqual(['current',direction==='ltr'?'right':'left']);
  });
  it('keeps vertical lookahead bounded without recursively advancing a completed anchor',()=>{
    const items=Array.from({length:20},(_,n)=>slice(String(n),0,n*1000));
    expect(ids(readingImages(items.reverse(),1200,900))).toEqual(['0','1','2','3','4']);
    expect(readingImages(items.slice(0,-1),1200,900)).toEqual([]);
  });
  it('keeps a still-visible previous-page sliver ahead of speculative lookahead',()=>{
    const items=[slice('previous',0,-290),slice('current',0,34),slice('next-visible',0,880),
      ...Array.from({length:4},(_,n)=>slice(`ahead-${n}`,0,1200+n*900))];
    expect(ids(readingImages(items,1200,900))).toEqual(['current','previous','next-visible','ahead-0','ahead-1']);
  });
  it('retains both on-screen pages before spending the eleven-display budget on nearby images',()=>{
    const visible=[...page('left',100),...page('right',600)];
    const away=Array.from({length:30},(_,n)=>slice(`away-${n}`,-1000-n*500));
    const retained=retainedImages([...visible.slice(0,3),...away,...visible.slice(3)],1200,900);
    expect(retained.size).toBe(11);
    expect(visible.every(item=>retained.has(item))).toBe(true);
    expect(retained.has(away[29])).toBe(false);
  });
  it('does not evict visible slices when they outnumber the spare display cache',()=>{
    const visible=Array.from({length:12},(_,n)=>slice(String(n),(n%4)*300,Math.floor(n/4)*300));
    const away=slice('away',2000);
    expect(ids(retainedImages([...visible,away],1200,900))).toEqual(ids(visible));
    expect(readingImages([...visible,away],1200,900)).toHaveLength(12);
  });
});

describe('inline bounded execution batch',()=>{
  it('fills a freed slot without dropping pending work or waiting for a slow peer',()=>{
    const items=Array.from({length:8},(_,n)=>({id:String(n),checked:false,pending:false}));
    expect(ids(readingBatch(items))).toEqual(['0','1','2','3','4']);
    for(const item of items.slice(0,5)){item.checked=true;item.pending=true;}
    expect(ids(readingBatch(items))).toEqual(['0','1','2','3','4']);
    items[1].pending=false;
    expect(ids(readingBatch(items))).toEqual(['0','2','3','4','5']);
    for(const item of items){item.checked=true;item.pending=false;}
    expect(readingBatch(items)).toEqual([]);
  });
  it('does not confuse an existing displayed result with completion of a newer request',()=>{
    const item={id:'old-display',checked:true,pending:true,resultKey:'old-result'};
    expect(readingBatch([item])).toEqual([item]);
  });
  it('skips successful, no-text and failed responses but prioritizes an explicit retry',()=>{
    const items=[{id:'success',checked:true},{id:'no-text',checked:true},{id:'failure',checked:true},
      ...Array.from({length:6},(_,n)=>({id:`new-${n}`,checked:false}))];
    expect(ids(readingBatch(items))).toEqual(['new-0','new-1','new-2','new-3','new-4']);
    expect(ids(readingBatch(items,'failure'))).toEqual(['failure']);
    // A manual response must not mark unchecked neighbours as already submitted.
    expect(ids(readingBatch(items))).toEqual(['new-0','new-1','new-2','new-3','new-4']);
    expect(ids(readingBatch(items,'removed'))).toEqual(['new-0','new-1','new-2','new-3','new-4']);
    items[0].checked=false;
    expect(readingBatch(items)[0].id).toBe('success');
  });
});
