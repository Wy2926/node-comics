import {msg} from '../../i18n/runtime';
import {readLinkedChapter} from '../../sources';
import type {ReadingEntry} from '../../types';
import {pageReference, RENDER_PROFILE, type PageReference} from './identity';

const prefix='temporary:';
export const isTemporaryEntry=(id?:string)=>!!id?.startsWith(prefix);
const sessions=new Map<string,{pages:Awaited<ReturnType<typeof readLinkedChapter>>['pages'];signal:AbortSignal}>();

/** Reader-only identities, even when this chapter also has a durable shelf entry. */
export async function openTemporaryChapter(url:string, signal:AbortSignal):Promise<ReadingEntry> {
  const source=await readLinkedChapter(url,signal);
  signal.throwIfAborted();
  const id=prefix+crypto.randomUUID(),now=Date.now();
  const pages=Array.from(source.pages,([pageId,{width,height}],i)=>{
    const ref={entryId:id,contentId:id,pageId,renderProfileId:RENDER_PROFILE};
    return {...ref,id:pageId,name:msg('第 {0} 页',{'0':i+1}),width:width||900,height:height||1300,imageDimensionsKnown:!!width&&!!height,
      blobKey:pageReference(ref),jobs:[],outputBlobs:{}};
  });
  sessions.set(id,{pages:source.pages,signal});
  signal.addEventListener('abort',()=>sessions.delete(id),{once:true});
  return {id,contentId:id,title:source.title,source:'website',sourceKey:id,sourceUrl:source.url,generation:1,
    createdAt:now,updatedAt:now,pages,pageId:pages[0].id,relativeOffset:0,discoveryComplete:true,knownTotal:pages.length};
}

export function temporaryPage(ref:PageReference) {
  const session=sessions.get(ref.entryId),page=session?.pages.get(ref.pageId);
  if(!session || !page || ref.contentId!==ref.entryId || ref.renderProfileId!==RENDER_PROFILE)
    throw Error(msg('来源清单已失效，请重新发现。'));
  return {read:page.read,validate:async()=>session.signal.throwIfAborted()};
}
