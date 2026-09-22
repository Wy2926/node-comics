import {msg} from '../i18n/runtime';
import {discoverImageDocument,discoverMangaCopyDocument} from './builtin';
import {comicPashAdapter} from './comicpash';
import {isMangaCopyUrl} from './mangacopy';
import {readMangaCopyData} from './mangacopy-data';
import {safeImageUrl} from './urls';
import type {PageImage,SourceAdapter} from './model';
export type {PageManifest,SourceItem} from './model';
export {safeImageUrl} from './urls';

const singlePage=(id:string,name:string,hosts:string[],selector:string):SourceAdapter=>({id,name,matches:url=>hosts.includes(url.hostname),discover:(doc,url)=>discoverImageDocument(doc,url,{id,selector,singlePage:true})});
export const sourceAdapters:readonly SourceAdapter[]=[
 comicPashAdapter,
 {id:'mangacopy',name:'MangaCopy',matches:url=>isMangaCopyUrl(url.href),discover:discoverMangaCopyDocument,read:readMangaCopyData},
 singlePage('xkcd','xkcd',['xkcd.com','www.xkcd.com'],'#comic img'),
 singlePage('gunnerkrigg','Gunnerkrigg',['gunnerkrigg.com','www.gunnerkrigg.com'],'img.comic_image, #comic img'),
];
const generic:SourceAdapter={id:'generic',name:'',matches:()=>true,discover:discoverImageDocument};
export const sourceName=(id:string)=>sourceAdapters.find(adapter=>adapter.id===id)?.name??msg('网页图片');
export function sourceAdapter(url:string){return sourceAdapters.find(adapter=>adapter.matches(new URL(url)))??generic;}
export function discoverDocument(doc:Document,url:string){return sourceAdapter(url).discover(doc,url);}
export function readSourceDocument(doc:Document,url:string){const adapter=sourceAdapter(url);return adapter.read?adapter.read(doc,url):Promise.resolve(adapter.discover(doc,url));}
export function sourcePageImages(doc:Document,url:string):PageImage[]{
 const adapter=sourceAdapter(url);
 if(adapter.images)return adapter.images(doc,url);
 return [...doc.images].flatMap(element=>{
  const raw=element.currentSrc||element.src;
  const source=raw.startsWith('blob:')&&new URL(raw).origin===new URL(url).origin||/^data:image\/(?:png|jpeg|webp|gif|avif);/i.test(raw)?raw:safeImageUrl(raw,url);
  return source?[{element,key:source,url:source}]:[];
 });
}
