import {describe,it,expect} from 'vitest';
import {sourceAdapter,discoverDocument} from '../src/sources/adapters';
import {PageImageRegistry,canvasImage} from '../src/sources/page-images';
import {readingImages} from '../src/inline/protocol';
import type {PageImage} from '../src/sources/model';

const url='https://comicpash.jp/episodes/60cfe4785e2af';
function fixture(){
 const canvases=[{width:654,height:930,isConnected:true},{width:654,height:930,isConnected:true}];
 const pages=[0,1,2].map(n=>({classList:{contains:()=>n!==1},querySelector:(selector:string)=>selector==='.-cv-page-canvas'?{}:n===1?null:canvases[n===0?0:1],contains:(canvas:unknown)=>canvas===canvases[n===0?0:1]&&n!==1}));
 // Book recommendations and the like/end screens also use -cv-page, without a canvas container.
 const doc={title:'Fixture',querySelector:()=>({getAttribute:()=> 'episode-1'}),querySelectorAll:()=>[...pages,{querySelector:()=>null}]} as unknown as Document;
 return {doc,canvases,pages};
}
describe('site adapter registry and Comic PASH canvases',()=>{
 it.each(['https://comicpash.jp.evil.test/episodes/a','https://comicpash.jp/series/a','https://other.example/episodes/a'])('does not match unrelated URLs: %s',url=>expect(sourceAdapter(url).id).toBe('generic'));
 it('routes existing sites through the registry',()=>{
  for(const [url,id] of [['https://xkcd.com/1','xkcd'],['https://www.gunnerkrigg.com/','gunnerkrigg'],['https://copy4000.com/comic/a/chapter/1','mangacopy']])expect(sourceAdapter(url).id).toBe(id);
 });
 it('keeps loaded canvas slots in source order and a partial chapter partial',()=>{
  const {doc}=fixture(),snapshot=discoverDocument(doc,url),refresh=discoverDocument(doc,url);
  expect(snapshot).toMatchObject({adapter:'comicpash',knownTotal:3,discoveryComplete:false,direction:'rtl'});
  expect(snapshot.items.map(item=>item.order)).toEqual([0,2]);
  expect(snapshot.items.map(item=>item.url)).toEqual(refresh.items.map(item=>item.url));
 });
 it('starts an RTL spread at the right page and includes the left page',()=>{
  const items=[600,0,-600].map((left,id)=>({id,rect:{top:0,bottom:800,left,right:left+600}}));
  expect(readingImages(items,1200,900,'rtl').map(item=>item.id)).toEqual([0,1,2]);
 });
 it('rejects unregistered, resized, detached or rebound page image handles',async()=>{
  const {doc,canvases}=fixture(),snapshot=discoverDocument(doc,url),adapter=sourceAdapter(url),images=adapter.images!(doc,url),registry=new PageImageRegistry();
  await registry.register(snapshot,images);
  await expect(registry.read('page-image:unknown',url,'unknown',()=>images)).rejects.toThrow('来源已变化');
  await expect(registry.read(images[0].url,url+'/changed',snapshot.items[0].id,()=>images)).rejects.toThrow('来源已变化');
  await expect(registry.read(images[0].url,url,snapshot.items[0].id,()=>[{...images[0],element:{} as PageImage['element']}])).rejects.toThrow('来源已变化');
  canvases[0].width=800;await expect(registry.read(images[0].url,url,snapshot.items[0].id,()=>images)).rejects.toThrow('来源已变化');
  canvases[0].width=654;canvases[0].isConnected=false;await expect(registry.read(images[0].url,url,snapshot.items[0].id,()=>images)).rejects.toThrow('来源已变化');
 });
 it('reports tainted and oversized canvases without reading their pixels',async()=>{
  const canvas={width:800,height:1200,toBlob:()=>{throw Error('sensitive browser message');}} as unknown as HTMLCanvasElement;
  await expect(canvasImage(canvas)).rejects.toThrow('网页原图读取失败');
  await expect(canvasImage({...canvas,width:20000,height:20000} as HTMLCanvasElement)).rejects.toThrow('尺寸');
 });
});
