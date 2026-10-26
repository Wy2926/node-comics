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
  it.each([{width:1000,height:1500},{width:1500,height:1000},{width:1000,height:3000},{width:800,height:24000}])('initializes every desktop image %j to width and 50 percent',page=>{
    expect(initialReadingView(page)).toEqual({mode:'classic',preference:'original',zoom:50,fit:'width'});
  });
  it.each([undefined,{width:0,height:1300},{width:900,height:0},{width:NaN,height:3000},{width:900,height:Infinity}])('uses the desktop sizing before real dimensions arrive: %j',page=>{
    expect(initialReadingView(page)).toEqual({mode:'classic',preference:'original',zoom:50,fit:'width'});
  });
  it('uses the full phone width for a new long image without changing a saved zoom',()=>{
    expect(initialReadingView({width:800,height:24000},true)).toEqual({mode:'classic',preference:'original',zoom:100,fit:'width'});
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'original',zoom:50,fit:'width'})});
    expect(readStoredReadingView('comic')?.zoom).toBe(50);
  });
  it.each([{width:1000,height:1500},{width:1500,height:1000},{width:1000,height:2999}])('keeps a regular phone image %j at window and 100 percent',page=>{
    expect(initialReadingView(page,true)).toEqual({mode:'classic',preference:'original',zoom:100,fit:'window'});
  });
  it.each([undefined,{width:0,height:1300},{width:900,height:0},{width:NaN,height:3000},{width:900,height:Infinity}])('waits for known valid phone image dimensions %j',page=>{
    expect(initialReadingView(page,true)).toBeUndefined();
  });
  it.each([false,true])('uses the selected global zoom only for a new comic (touch: %s)',touch=>{
    const stored=new Map<string,string>();
    vi.stubGlobal('localStorage',{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value)});
    const page={width:800,height:2400},key=readingViewKey('existing');
    saveReadingView(key,initialReadingView(page,touch,130)!);
    expect((readStoredReadingView(key)??initialReadingView(page,touch,70))?.zoom).toBe(130);
    expect((readStoredReadingView(readingViewKey('new'))??initialReadingView(page,touch,70))?.zoom).toBe(70);
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
  it.each(['continuous','single','double'] as const)('restores an explicit %s layout independently from the other comic choices',layout=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',zoom:140,fit:'width',layout,direction:'rtl'})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'translation',zoom:140,fit:'width',layout,direction:'rtl'});
  });
  it.each(['ltr','rtl'] as const)('restores an explicit %s direction without fixing a layout',direction=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'original',zoom:80,fit:'window',direction})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'original',zoom:80,fit:'window',direction});
  });
  it.each([null,'default','spread','',0,{},[],true])('omits an invalid layout %j without losing valid comic preferences',layout=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',zoom:140,fit:'width',layout,direction:'rtl'})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'translation',zoom:140,fit:'width',direction:'rtl'});
  });
  it.each([null,'default','right','',0,{},[],true])('omits an invalid direction %j without losing the selected layout',direction=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',zoom:140,fit:'width',layout:'double',direction})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'translation',zoom:140,fit:'width',layout:'double'});
  });
  it('keeps layout and direction valid even when unrelated viewing fields are corrupt',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'unknown',preference:'translation',zoom:-1,fit:'unknown',layout:'double',direction:'rtl'})});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'original',zoom:100,fit:'window',layout:'double',direction:'rtl'});
  });
  it('keeps absent and legacy records on the current global defaults without storing inherited values',()=>{
    const saved=new Map<string,string>([['legacy',JSON.stringify({mode:'classic',preference:'translation',zoom:140,fit:'width'})]]);
    vi.stubGlobal('localStorage',{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    for(const key of ['new','legacy']){
      const view=readReadingView(key);
      expect(view).not.toHaveProperty('layout');expect(view).not.toHaveProperty('direction');
      for(const defaults of [{layout:'single',direction:'ltr'},{layout:'double',direction:'rtl'}] as const){
        expect(view.layout??defaults.layout).toBe(defaults.layout);
        expect(view.direction??defaults.direction).toBe(defaults.direction);
      }
      saveReadingView(key,view);
      const stored=JSON.parse(saved.get(key)!);
      expect(stored).not.toHaveProperty('layout');expect(stored).not.toHaveProperty('direction');
    }
    expect(readReadingView('legacy')).toEqual({mode:'classic',preference:'translation',zoom:140,fit:'width'});
  });
  it('restores independent per-comic layout and direction after reloading the store',()=>{
    const saved=new Map<string,string>();
    const storage=()=>({getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    vi.stubGlobal('localStorage',storage());
    const a=readingViewKey('comic-a'),b=readingViewKey('comic-b');
    saveReadingView(a,{...readReadingView(a),layout:'double',direction:'rtl'});
    saveReadingView(b,{...readReadingView(b),layout:'continuous',direction:'ltr'});
    vi.stubGlobal('localStorage',storage());
    expect(readReadingView(readingViewKey('comic-a'))).toMatchObject({layout:'double',direction:'rtl'});
    expect(readReadingView(b)).toMatchObject({layout:'continuous',direction:'ltr'});
    expect(readReadingView(readingViewKey('comic-c'))).not.toHaveProperty('layout');
  });
  it('keeps an explicit layout equal to the old global default when that default changes',()=>{
    const saved=new Map<string,string>();
    vi.stubGlobal('localStorage',{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    const selected={...readReadingView('comic'),layout:'single' as const};
    saveReadingView('comic',selected);
    for(const defaultLayout of ['single','double','continuous'] as const){
      expect(readReadingView('comic').layout??defaultLayout).toBe('single');
      expect(readReadingView('other').layout??defaultLayout).toBe(defaultLayout);
    }
  });
  it('clears only the layout override when following the global default again',()=>{
    const saved=new Map<string,string>();
    vi.stubGlobal('localStorage',{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    saveReadingView('comic',{mode:'classic',preference:'translation',zoom:140,fit:'width',layout:'double',direction:'ltr'});
    saveReadingView('comic',{...readReadingView('comic'),layout:undefined});
    const view=readReadingView('comic');
    expect(view).toEqual({mode:'classic',preference:'translation',zoom:140,fit:'width',direction:'ltr'});
    expect(JSON.parse(saved.get('comic')!)).not.toHaveProperty('layout');
    expect(view.layout??'continuous').toBe('continuous');
    saveReadingView('comic',{...view,layout:'single',direction:undefined});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'translation',zoom:140,fit:'width',layout:'single'});
  });
  it('handles unavailable storage without blocking the reader',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>{throw Error('Unavailable');},setItem:()=>{throw Error('Quota exceeded');}});
    expect(readReadingView('comic')).toEqual({mode:'classic',preference:'original',zoom:100,fit:'window'});
    expect(()=>saveReadingView('comic',{mode:'classic',preference:'original',zoom:140,fit:'width',layout:'double',direction:'rtl'})).not.toThrow();
  });
});
