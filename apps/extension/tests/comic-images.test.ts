import {afterEach,describe,expect,it,vi} from 'vitest';
import {discoverDocument} from '../src/sources/adapters';
import {comicImageRect} from '../src/sources/comic-images';

afterEach(()=>vi.unstubAllGlobals());
function image(name:string,options:Record<string,unknown>={}){
 return {src:`https://images.example/${name}`,currentSrc:'',dataset:{},complete:true,naturalWidth:320,naturalHeight:400,
  getBoundingClientRect:()=>({width:400,height:500}),checkVisibility:()=>true,...options} as unknown as HTMLImageElement;
}
describe('shared webpage image candidates',()=>{
 it('uses rendered size, load status and visibility for both discovery and translation',()=>{
  vi.stubGlobal('getComputedStyle',()=>({visibility:'visible',opacity:'1'}));
  const images=[image('small-source'),image('strip',{getBoundingClientRect:()=>({width:300,height:8000})}),
   image('thumbnail',{naturalWidth:2000,naturalHeight:3000,getBoundingClientRect:()=>({width:100,height:150})}),
   image('banner',{getBoundingClientRect:()=>({width:1600,height:400})}),image('loading',{complete:false}),
   image('placeholder',{naturalWidth:1,naturalHeight:1,dataset:{src:'https://images.example/full'}}),
   image('hidden',{checkVisibility:()=>false})];
  expect(images.filter(img=>comicImageRect(img)).map(img=>img.src)).toEqual(images.slice(0,2).map(img=>img.src));
  const doc={title:'Page',querySelectorAll:()=>images} as unknown as Document;
  const manifest=discoverDocument(doc,'https://example.test/page');
  expect(manifest.items.map(item=>item.url)).toEqual(images.slice(0,2).map(img=>img.src));
  expect(manifest.items[0]).toMatchObject({width:320,height:400});
  expect(manifest.discoveryComplete).toBe(false);
 });
 it.each([{visibility:'hidden',opacity:'1'},{visibility:'visible',opacity:'0'}])('rejects hidden CSS %j',css=>{
  vi.stubGlobal('getComputedStyle',()=>css);expect(comicImageRect(image('hidden'))).toBeUndefined();
 });
 it('uses currentSrc like inline translation, deduplicates and keeps IDs across refresh',()=>{
  vi.stubGlobal('getComputedStyle',()=>({visibility:'visible',opacity:'1'}));
  const img=image('fallback',{currentSrc:'https://images.example/current',dataset:{src:'https://images.example/lazy'}});
  const doc={title:'Page',querySelectorAll:()=>[img,img,image('second')]} as unknown as Document;
  const first=discoverDocument(doc,'https://example.test/page');
  expect(first.items.map(item=>item.url)).toEqual([img.currentSrc,'https://images.example/second']);
  const next=discoverDocument({...doc,querySelectorAll:()=>[image('second')]} as unknown as Document,'https://example.test/page');
  expect(next.items[0].id).toBe(first.items[1].id);
 });
});
