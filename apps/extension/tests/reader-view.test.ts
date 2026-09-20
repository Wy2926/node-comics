import {afterEach,describe,expect,it,vi} from 'vitest';
import {emptyLibrary} from '../src/library/model';
import type {CopyCoverage} from '../src/library/types';
import {readingViewKey,readReadingView,saveReadingView} from '../src/reader/view';

afterEach(()=>vi.unstubAllGlobals());
describe('comic viewing choices',()=>{
  it('starts each work on originals and shares explicit choices only within that work',()=>{
    const saved=new Map<string,string>();
    vi.stubGlobal('localStorage',{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    const library={...emptyLibrary(),coverage:[['chapter-a','work-a'],['chapter-b','work-a'],['edition-a','work-a'],['chapter-c','work-b']].map(([copyId,workId])=>({copyId,workId} as CopyCoverage))};
    const keys=['chapter-a','chapter-b','edition-a','chapter-c'].map(id=>readingViewKey(library,id));
    expect(readReadingView(keys[0],'redraw')).toEqual({mode:'redraw',preference:'original'});
    saveReadingView(keys[0],{mode:'classic',preference:'translation'});
    for(const key of keys.slice(0,3))expect(readReadingView(key,'redraw')).toEqual({mode:'classic',preference:'translation'});
    expect(readReadingView(keys[3],'classic').preference).toBe('original');
    saveReadingView(keys[1],{mode:'classic',preference:'original'});
    expect(readReadingView(keys[0],'classic').preference).toBe('original');
    expect(readingViewKey(library,'unassigned-a')).not.toBe(readingViewKey(library,'unassigned-b'));
  });
  it.each(['broken','null','{"mode":"unknown","preference":"translation"}','{"mode":"classic","preference":"auto"}'])('fails closed for invalid stored preference %s',value=>{
    vi.stubGlobal('localStorage',{getItem:()=>value});
    expect(readReadingView('comic','classic')).toEqual({mode:'classic',preference:'original'});
  });
});
