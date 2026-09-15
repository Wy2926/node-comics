import type {PageManifest} from '../sources/adapters';
import {sourcePageIdentity} from '../sources/mangacopy';
import {sourceMessage} from '../sources/client';
import {sourceImage} from '../sources/image-fetch';
import {hashFile,imageIdentity} from '../importers/hash';
import {emptyPage} from '../reader/model';
import type {ReadingCopy} from '../types';
import type {ImportAssignment,LibraryState} from './types';
import {makeCopy} from './model';
import {cacheSize,collectUnusedBlobs,copyBlobKeys,editLibrary,enforceCacheBudget,getBlob,putBlob,readCopies,readPosition,savePosition} from './store';

export type InsertPosition={kind:'start'|'end'}|{kind:'after';pageId:string};
export type WebDestination={mode:'new';assignment:ImportAssignment;title:string}|{mode:'insert';copyId:string;revision:number;position:InsertPosition};

export function insertionBlocked(copy:ReadingCopy,library:LibraryState):string|undefined{
 if(library.tasks.some(task=>task.copyId===copy.id&&['queued','running'].includes(task.status)))return '请先在采集中心暂停此副本，再插入图片。';
 if(copy.sourceEntryId&&!copy.discoveryComplete)return '此副本的来源页序尚未完整，请先补齐图片清单。';
}

/** Download only the selected, trusted snapshot. Permission request retains the click's user activation. */
export async function acquireWebImages(manifest:PageManifest,limitMb:number,progress:(text:string)=>void,protectedCopyId?:string):Promise<ReadingCopy>{
 const origins=[...new Set(manifest.items.map(item=>new URL(item.url).origin+'/*'))];
 if(!manifest.items.length)throw Error('请至少选择一张图片。');
 if(origins.length&&!await chrome.permissions.request({origins}))throw Error('未取得图片域名权限，请重试授权或导入本地图片。');
 const digest=await hashFile(new Blob([JSON.stringify(manifest.items.map(item=>item.url))]));
 const source=({generic:'网页图片','context-menu':'网页图片',mangacopy:'MangaCopy',xkcd:'xkcd',gunnerkrigg:'Gunnerkrigg'} as Record<string,string>)[manifest.adapter]??'网页图片';
 const copy={...makeCopy(manifest.title,[],source,'web:'+sourcePageIdentity(manifest.url)+':'+digest),sourceUrl:manifest.url,discoveryComplete:manifest.discoveryComplete,knownTotal:manifest.items.length};
 try{
  for(const item of manifest.items){
   const page={...emptyPage(`第 ${copy.pages.length+1} 页`,item.width||800,item.height||1200),sourceUrl:item.url};copy.pages.push(page);
   try{
    const valid=await sourceMessage<{url:string}>({type:'NC_SOURCE_IMAGE',manifestId:manifest.id,pageId:item.id});
    if(valid.url!==item.url)throw Error('图片来源已变化，请重新发现。');
    const blob=await sourceImage(valid.url),bitmap=await createImageBitmap(blob);page.width=bitmap.width;page.height=bitmap.height;bitmap.close();
    if(!page.width||!page.height||page.width*page.height>100000000)throw Error('原图尺寸不可用。');
    Object.assign(page,await imageIdentity(blob));const key='original:'+page.imageSha256;
    if(!await getBlob(key)){
     await enforceCacheBudget([...(await readCopies()),copy],Math.max(0,limitMb-blob.size/1024/1024),protectedCopyId??copy.id);
     if(await cacheSize()+blob.size>limitMb*1024*1024)throw Error('本地空间预算不足，请提高上限或清理副本后重试。');
     await putBlob(key,blob);
    }
    page.blobKey=key;
   }catch(e){page.fetchError=(e as Error).message;}
   progress(`正在获取原图 ${copy.pages.length} / ${manifest.items.length}…`);
  }
  copy.pageId=copy.pages[0]?.id??'';return copy;
 }catch(e){await collectUnusedBlobs(copyBlobKeys(copy));throw e;}
}

/** Atomic insertion with a receipt: repeat submissions restore failed bytes instead of duplicating pages. */
export async function insertWebCopy(incoming:ReadingCopy,destination:Extract<WebDestination,{mode:'insert'}>){
 const result=await editLibrary((library,copies)=>{
  const copy=copies.find(copy=>copy.id===destination.copyId);
  if(!copy)throw Error('目标副本已移除，请重新选择。');
  if(!incoming.pages.length)throw Error('没有可插入的图片。');
  const key=incoming.sourceKey+':'+JSON.stringify(destination.position),receipt=copy.webImports?.find(item=>item.key===key);
  if(receipt){
   receipt.pageIds.forEach((id,index)=>{
    const page=copy.pages.find(page=>page.id===id),fresh=incoming.pages[index];
    if(page&&!page.blobKey&&fresh?.blobKey&&(!page.imageSha256||page.imageSha256===fresh.imageSha256))Object.assign(page,{blobKey:fresh.blobKey,width:fresh.width,height:fresh.height,imageSha256:fresh.imageSha256,fileHash:fresh.fileHash,pageIndex:fresh.pageIndex,fetchError:undefined});
   });
   return {copyId:copy.id,added:0,revision:copy.manifestRevision,position:undefined};
  }
  const blocked=insertionBlocked(copy,library);if(blocked)throw Error(blocked);
  if(copy.manifestRevision!==destination.revision)throw Error('目标副本的页序已改变，请重新选择插入位置。');
  const position=readPosition(copy.id,copy.manifestRevision)??{pageId:copy.pageId,relativeOffset:copy.relativeOffset};
  let at=destination.position.kind==='start'?0:copy.pages.length;
  if(destination.position.kind==='after'){
   const anchorId=destination.position.pageId;at=copy.pages.findIndex(page=>page.id===anchorId)+1;
   if(!at)throw Error('插入位置已移除，请重新选择。');
  }
  const pages=incoming.pages.map(page=>({...page,id:crypto.randomUUID()}));
  copy.pages.splice(at,0,...pages);copy.manifestRevision++;copy.updatedAt=Date.now();
  if(copy.sourceEntryId)copy.sourcePagesEdited=true;
  if(!copy.sourceEntryId||copy.discoveryComplete)copy.knownTotal=copy.pages.length;
  if(!copy.pages.some(page=>page.id===position.pageId)){position.pageId=copy.pages[0].id;position.relativeOffset=0;}
  Object.assign(copy,position);
  (copy.webImports??=[]).push({key,pageIds:pages.map(page=>page.id)});
  for(const coverage of library.coverage.filter(item=>item.copyId===copy.id)){const work=library.works.find(work=>work.id===coverage.workId);if(work)work.updatedAt=copy.updatedAt;}
  const task=library.tasks.find(task=>task.copyId===copy.id);
  if(task){task.total=copy.pages.length;task.completed=copy.pages.filter(page=>page.blobKey).length;task.status=task.completed===task.total?'complete':'paused';task.error=task.status==='paused'?'有原图待获取，可在采集中心继续。':undefined;task.updatedAt=copy.updatedAt;}
  return {copyId:copy.id,added:pages.length,revision:copy.manifestRevision,position};
 });
 if(result.position)savePosition(result.copyId,result.revision,result.position);
 return result;
}
