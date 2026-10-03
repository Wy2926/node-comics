import {afterEach,describe,expect,it,vi} from 'vitest';
import {initialReadingView,readingViewKey,readReadingView,readStoredReadingView,saveReadingView} from '../src/reader/view';

afterEach(()=>vi.unstubAllGlobals());
describe('comic viewing choices',()=>{
  it('distinguishes an absent comic view from an existing legacy or corrupt record',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>null});expect(readStoredReadingView('comic')).toBeUndefined();
    for(const raw of ['null','broken','{}',JSON.stringify({mode:'classic',preference:'translation',zoom:140})]){
      vi.stubGlobal('localStorage',{getItem:()=>raw});expect(readStoredReadingView('comic')).toBeDefined();
    }
  });
  it.each([{width:1000,height:3000},{width:800,height:24000}])('initializes a first long image %j to width and 50 percent',page=>{
    expect(initialReadingView(page)).toEqual({mode:'classic',preference:'original',zoom:50,fit:'width'});
  });
  it.each([{width:1000,height:1500},{width:1500,height:1000},{width:1000,height:2999}])('keeps a regular image %j at window and 100 percent',page=>{
    expect(initialReadingView(page)).toEqual({mode:'classic',preference:'original',zoom:100,fit:'window'});
  });
  it.each([undefined,{width:0,height:1300},{width:900,height:0},{width:NaN,height:3000},{width:900,height:Infinity}])('waits for known valid image dimensions %j',page=>{
    expect(initialReadingView(page)).toBeUndefined();
  });
  it('starts each work on originals and shares explicit choices only within that work',()=>{
    const saved=new Map<string,string>();
    vi.stubGlobal('localStorage',{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    const keys=['comic-a','comic-a','comic-a','comic-b'].map(comicId=>readingViewKey(comicId));
    expect(readReadingView(keys[0])).toEqual({mode:'classic',preference:'original',zoom:100,fit:'window'});
    saveReadingView(keys[0],{mode:'classic',preference:'translation',zoom:130,fit:'width'});
    for(const key of keys.slice(0,3))expect(readReadingView(key)).toEqual({mode:'classic',preference:'translation',zoom:130,fit:'width'});
    expect(readReadingView(keys[3]).preference).toBe('original');
    saveReadingView(keys[1],{mode:'classic',preference:'original',zoom:130,fit:'width'});
    expect(readReadingView(keys[0]).preference).toBe('original');
    expect(readingViewKey('comic-a')).not.toBe(readingViewKey('comic-b'));
  });
  it.each(['broken','null','{"mode":"unknown","preference":"translation"}','{"mode":"classic","preference":"auto"}'])('fails closed for invalid stored preference %s',value=>{
    vi.stubGlobal('localStorage',{getItem:()=>value});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'original',zoom:100,fit:'window'});
  });
  it('restores separate zoom ratios after switching comics and reloading the store',()=>{
    const saved=new Map<string,string>();
    const storage=()=>({getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    vi.stubGlobal('localStorage',storage());
    const a=readingViewKey('comic-a'),b=readingViewKey('comic-b');
    saveReadingView(a,{mode:'classic',preference:'original',zoom:150,fit:'width'});
    expect(readReadingView(b).zoom).toBe(100);
    saveReadingView(b,{mode:'classic',preference:'translation',zoom:80,fit:'window'});
    vi.stubGlobal('localStorage',storage());
    expect(readReadingView(a)).toEqual({mode:'classic',preference:'original',zoom:150,fit:'width'});
    expect(readReadingView(b)).toEqual({mode:'classic',preference:'translation',zoom:80,fit:'window'});
  });
  it('keeps legacy viewing preferences with the default zoom',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation'})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'translation',zoom:100,fit:'window'});
  });
  it.each([40,100,200])('restores a valid zoom of %s percent',zoom=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'original',zoom})});
    expect(readReadingView('comic').zoom).toBe(zoom);
  });
  it.each([null,'150',39,201,155,{},1e308])('defaults invalid zoom %j without losing the translation choice',zoom=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',zoom})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'translation',zoom:100,fit:'window'});
  });
  it('keeps valid zoom without enabling an invalid translation preference',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'unknown',preference:'translation',zoom:120})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'original',zoom:120,fit:'window'});
  });
  it.each(['window','width'] as const)('restores an explicit %s fit without changing the comic viewing choice or zoom',fit=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',zoom:140,fit})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'translation',zoom:140,fit});
  });
  it.each([null,'auto','unknown',100,{},[]])('defaults invalid fit %j independently from the viewing choice and zoom',fit=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',zoom:140,fit})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'translation',zoom:140,fit:'window'});
  });
  it('handles unavailable storage without blocking the reader',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>{throw Error('Unavailable');},setItem:()=>{throw Error('Quota exceeded');}});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'original',zoom:100,fit:'window'});
    expect(()=>saveReadingView('comic',{mode:'classic',preference:'original',zoom:140,fit:'width'})).not.toThrow();
  });
});
