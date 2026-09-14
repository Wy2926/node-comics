import type { Chapter, Mode, Page } from '../types';
export const automaticScope = (chapterId:string|undefined, ownerId:string|undefined, origin:string, language:string, mode:Mode) => JSON.stringify([chapterId,ownerId,origin,language,mode]);
export const id = () => crypto.randomUUID();
export const naturalSort = <T extends {name:string}>(items:T[]) => [...items].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'}));
export const activeWindow = (index:number,count:number,radius=2) => ({start:Math.max(0,index-radius),end:Math.min(count-1,index+radius)});
export function anchorFor(top:number,height:number,viewportTop:number) {return Math.max(0,Math.min(1,(viewportTop-top)/Math.max(1,height)));}
export const emptyPage = (name:string,width:number,height:number):Page => ({id:id(),name,width,height,jobs:[],outputBlobs:{},operationIds:{}});
export const makeChapter = (title:string,pages:Page[],source='本地导入'):Chapter => ({id:id(),title,source,createdAt:Date.now(),updatedAt:Date.now(),pages,pageId:pages[0]?.id??'',relativeOffset:0});
/** A reimport restores bytes without resetting a curated directory, title or reading position. */
export function restoreImported(chapters:Chapter[],incoming:Chapter):Chapter {
  const key=(p:Page)=>p.fileHash&&p.pageIndex!=null?`${p.fileHash}:${p.pageIndex}`:undefined;
  const incomingPages=new Map(incoming.pages.filter(p=>key(p)).map(p=>[key(p)!,p]));
  const existing=chapters.find(c=>c.pages.length>0&&c.pages.every(p=>key(p)&&incomingPages.has(key(p)!)));
  if(!existing)return incoming;
  return {...existing,pages:existing.pages.map(p=>{const restored=incomingPages.get(key(p)!)!;return {...p,blobKey:restored.blobKey,width:restored.width,height:restored.height,fetchError:undefined};})};
}
