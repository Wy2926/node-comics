import {sourceLock} from './locks';
import {catalog, type CatalogWrite} from '../repositories';
import type {Comic, Entry, PageDescriptor, SourceConnection} from '../domain';
import {importContainer, openContainer, releaseContainer, type ManagedContainer} from '../../storage/containers';
import {openDocument} from '../formats';
import type {ComicFormat, IndexedPage} from '../formats/contracts';
import {openFileSource} from '../sources/runtime';
import type {SourceSelection} from '../sources/contracts';
import {sourceFor, safeImageUrl, isPageImageUrl, validateSourceCatalog, type PageManifest, type SourceCatalogSnapshot} from '../../sources';
import {getSourceDriver} from '../sources/registry';
import {Sha256} from '../../importers/hash';
import {beginImportJournal, completeImportJournal, recordCopiedFile} from './import-journal';
import {restoreSourceSelection} from './source-access';
import {sourcePageCache} from '../../storage/source-pages';
import {sourceRangeCache} from '../../storage/source-ranges';
import {thumbnailCache} from '../../storage/thumbnails';
import {downloadStore} from '../../storage/downloads';

const digest = (value:string) => new Sha256().update(new TextEncoder().encode(value)).digest();
export const stablePageId = (locator:unknown) => digest(JSON.stringify(locator));
const titleFor = (name:string) => name.replace(/\.[^.]+$/, '') || name;
const fileFormats = new Set(['cbz','cbr','pdf','mobi']);
type ConnectionInput = Pick<SourceConnection,'id'|'provider'|'accountId'|'displayName'>;
async function connection(input:ConnectionInput) {
  const existing=await catalog.get('connections',input.id);
  if(existing) {
    if(existing.provider!==input.provider||existing.accountId!==input.accountId)throw Error('来源账户身份不匹配。');
    return existing;
  }
  const now=Date.now();
  const value:SourceConnection={...input,status:'connected',generation:1,createdAt:now,updatedAt:now};
  await catalog.put('connections',value);return value;
}
function descriptors(contentId:string,pages:IndexedPage[]):PageDescriptor[] {
  return pages.map(page=>{const locator='sourceId' in page.locator?{url:page.locator.url,sourceId:page.locator.sourceId}:page.locator;return {...page,contentId,pageId:stablePageId(locator),formatLocator:JSON.stringify(locator)};});
}
async function filePages(context:Parameters<typeof openFileSource>[0]):Promise<IndexedPage[]> {
  const source=await openFileSource(context);
  try {const session=await openDocument(context.format,source,context.signal);try{return await session.index(context.signal);}finally{await session.close();}}
  finally {await source.close();}
}
interface FileRegistration {
  title:string; format:ComicFormat; connection:ConnectionInput; connectionGeneration?:number; resourceId:string;
  locator:Record<string,unknown>; snapshot?:Record<string,unknown>; containerId?:string; contentId:string; pages:IndexedPage[];
}
async function registerFile(input:FileRegistration):Promise<{id:string;comicId:string;created:boolean}> {
  if(!fileFormats.has(input.format)||!input.pages.length)throw Error('文件中未找到可读漫画页面。');
  const sourceKey=JSON.stringify([input.connection.id,input.resourceId]);
  const [existing]=await catalog.list('comics',{index:'sourceKey',range:sourceKey,limit:1});
  if(existing) {
    const active=await catalog.get('connections',input.connection.id);
    if(existing.source.status!=='active'||!active||active.status!=='connected'||input.connectionGeneration!==undefined&&active.generation!==input.connectionGeneration)throw Error('来源访问已变化，请重新选择文件。');
    const [entry]=await catalog.listEntries(existing.id,{limit:1});if(!entry)throw Error('漫画目录缺失，请移除后重新导入。');
    if(JSON.stringify(entry.sourceSnapshot)!==JSON.stringify(input.snapshot)) {
      await catalog.replaceContent(entry.id,entry.generation,{contentId:input.contentId,format:input.format,containerId:input.containerId,sourceSnapshot:input.snapshot},descriptors(input.contentId,input.pages),true);
      await Promise.all([sourcePageCache.deleteOwner(entry.id),sourceRangeCache.deleteOwner(entry.id),thumbnailCache.deleteOwner(entry.id)]);
    }
    return {id:entry.id,comicId:existing.id,created:false};
  }
  const now=Date.now(),comicId=crypto.randomUUID(),entryId=crypto.randomUUID();
  const comic:Comic={id:comicId,sourceKey,title:input.title,sourceName:input.connection.provider==='local'?'本地文件':getSourceDriver(input.connection.provider)?.label??input.connection.provider,source:{connectionId:input.connection.id,providerItemId:input.resourceId,locator:input.locator,generation:1,status:'active'},startEntryId:entryId,cover:{entryId,contentId:input.contentId,pageId:stablePageId(input.pages[0].locator)},createdAt:now,updatedAt:now};
  const entry:Entry={id:entryId,comicId,title:input.title,order:0,format:input.format,contentId:input.contentId,generation:1,indexState:'ready',containerId:input.containerId,sourceSnapshot:input.snapshot,createdAt:now,updatedAt:now,pageCount:input.pages.length,knownTotal:input.pages.length,discoveryComplete:true,coverPageId:comic.cover!.pageId};
  await connection(input.connection);
  const records:CatalogWrite[]=[{table:'comics',value:comic},{table:'entries',value:entry},...descriptors(input.contentId,input.pages).map(value=>({table:'pageDescriptors' as const,value}))];
  await catalog.mutate(['comics','entries','connections','pageDescriptors'],async tx=>{const current=await tx.get('connections',input.connection.id);if(!current||current.status!=='connected'||input.connectionGeneration!==undefined&&current.generation!==input.connectionGeneration)throw Error('来源连接已变化，请重试。');for(const record of records)await tx.put(record.table,record.value);});
  return {id:entryId,comicId,created:true};
}
export async function registerLocalContainer(container:ManagedContainer,contentId:string,signal?:AbortSignal) {
  const source=await openContainer(container.id);let pages:IndexedPage[];
  try {const session=await openDocument(container.format,source,signal);try {pages=await session.index(signal);}finally {await session.close();}} finally {await source.close();}
  signal?.throwIfAborted();
  return registerFile({title:titleFor(container.fileName??'漫画'),format:container.format,connection:{id:'local',provider:'local',displayName:'本地文件'},resourceId:container.id,locator:{containerId:container.id,name:container.fileName},containerId:container.id,contentId,pages});
}
async function saveLocalFile(file:File,signal?:AbortSignal,onProgress?:(label:string,done?:number,total?:number)=>void) {
  const contentId=crypto.randomUUID(),journal=await beginImportJournal(contentId,file);
  let container:ManagedContainer|undefined,registered=false;
  try {
    onProgress?.('正在保存完整源文件',0,file.size);
    container=await importContainer(file,signal,(done,total)=>onProgress?.('正在保存完整源文件',done,total),contentId);
    await recordCopiedFile(journal,container.id);
    onProgress?.('源文件已保存，正在建立目录');
    const result=await registerLocalContainer(container,contentId,signal);registered=result.created;
    if(!registered)await releaseContainer(container.id,contentId);
    await completeImportJournal(contentId);return result;
  } catch(error) {
    if(!registered&&container)await releaseContainer(container.id,contentId);
    await completeImportJournal(contentId).catch(()=>{});throw error;
  }
}
export const importLocalFile=(...args:Parameters<typeof saveLocalFile>)=>sourceLock(()=>saveLocalFile(...args));
export async function importSourceFiles(selection:SourceSelection,signal?:AbortSignal) {
  return sourceLock(async()=>{
    signal?.throwIfAborted();
    for(const file of selection.files)if(!fileFormats.has(file.format))throw Error('不支持图片导入，请选择漫画文件。');
    const connected=await connection(selection.connection);await restoreSourceSelection(selection);
    const results:{id:string;comicId:string;created:boolean;name:string}[]=[],failures:{name:string;error:string}[]=[];
    for(const file of selection.files) {
      signal?.throwIfAborted();
      try {
        const contentId=crypto.randomUUID();
        const source={connectionId:connected.id,providerItemId:file.id,locator:file.locator,generation:1,status:'active' as const};
        const current=await catalog.get('connections',connected.id);
        let pages:IndexedPage[];const owner='pending:'+contentId;
        try{pages=await filePages({connection:current!,source,contentId,entryId:owner,sourceSnapshot:file.snapshot,format:file.format,signal});}finally{await sourceRangeCache.deleteOwner(owner,true);}
        signal?.throwIfAborted();
        const result=await registerFile({title:titleFor(file.name),format:file.format,connection:selection.connection,connectionGeneration:current!.generation,resourceId:file.id,locator:file.locator,snapshot:file.snapshot,contentId,pages});
        results.push({...result,name:file.name});
      }catch(error){if(signal?.aborted)throw error;failures.push({name:file.name,error:(error as Error).message});}
    }
    return {results,failures};
  });
}
export async function reindexEntry(id:string,signal?:AbortSignal) {
  const entry=await catalog.get('entries',id);if(!entry)throw Error('漫画已移除。');
  if(entry.format==='website')throw Error('请通过已适配的网站重新载入内容。');
  const comic=await catalog.get('comics',entry.comicId),connected=comic&&await catalog.get('connections',comic.source.connectionId);
  if(!comic||!connected)throw Error('漫画来源已移除。');
  const pages=await filePages({connection:connected,source:comic.source,entryId:id,contentId:entry.contentId,sourceSnapshot:entry.sourceSnapshot,format:entry.format,containerId:entry.containerId,signal});
  await publishIndex(entry,pages,true);
}
export async function publishIndex(entry:Entry,pages:IndexedPage[],complete:boolean,total?:number) {
  if(!pages.length&&complete)throw Error('来源没有可读漫画页面。');
  const values=descriptors(entry.contentId,pages);
  for(let offset=0;offset<values.length;offset+=100)await catalog.putPages(entry.id,entry.contentId,values.slice(offset,offset+100),entry.generation);
  if(!await catalog.finishIndex(entry.id,entry.contentId,entry.generation,{pageCount:pages.length,knownTotal:total??(complete?pages.length:undefined),discoveryComplete:complete,coverPageId:values[0]?.pageId}))throw Error('来源内容已变化，请重新打开。');
}
function requireWebsite(url:string,adapter?:string) {
  const resolved=sourceFor(url);
  if(!resolved.definition.capabilities.importable||!resolved.definition.capabilities.pages||resolved.location.kind==='other'||adapter&&adapter!==resolved.definition.id)throw Error('此网站尚未专门适配，不能导入漫画。');
  return resolved;
}
async function websiteComic(url:string,title:string,resourceKey?:string) {
  const {definition,location}=requireWebsite(url),resourceId=resourceKey??location.catalog?.key??location.pageKey,sourceKey=JSON.stringify(['website:'+definition.id,resourceId]);
  const [existing]=await catalog.list('comics',{index:'sourceKey',range:sourceKey,limit:1});if(existing)return existing;
  const now=Date.now(),value:Comic={id:crypto.randomUUID(),sourceKey,title,sourceName:definition.name,sourceUrl:location.catalog?.url??url,source:{connectionId:'website:'+definition.id,providerItemId:resourceId,locator:{url:location.catalog?.url??url,catalogId:location.catalog?.key},generation:1,status:'active'},createdAt:now,updatedAt:now};
  await connection({id:value.source.connectionId,provider:'website',displayName:definition.name});
  await catalog.put('comics',value);return value;
}
export async function importCatalog(snapshot:SourceCatalogSnapshot):Promise<Comic> {
  return sourceLock(async()=>{
    const source=validateSourceCatalog(snapshot);requireWebsite(source.url,source.sourceId);
    const comic=await websiteComic(source.url,source.title),now=Date.now();
    await catalog.mutate(['comics','entries','catalogs'],async tx=>{
      const current=await tx.get('comics',comic.id);if(!current)throw Error('漫画已移除。');
      const existing=await tx.list('entries',{index:'comicId',range:comic.id,limit:10000});
      const bySource=new Map(existing.map(entry=>[entry.sourceEntryId,entry])),entries:Entry[]=[];
      for(const item of source.entries.filter(item=>!item.related)) {
        const previous=bySource.get(item.id);
        const entry:Entry=previous?{...previous,title:item.title,order:item.order,sequenceId:item.sequenceId,sourceUrl:item.url}:{id:crypto.randomUUID(),comicId:comic.id,title:item.title,order:item.order,sequenceId:item.sequenceId,sourceEntryId:item.id,sourceUrl:item.url,format:'website',contentId:crypto.randomUUID(),generation:1,indexState:'pending',createdAt:now,updatedAt:now};
        await tx.put('entries',entry);entries.push(entry);
      }
      const defaultEntry=entries.find(entry=>entry.sourceEntryId===source.defaultEntryId)??(entries.length===1?entries[0]:undefined);
      await tx.put('comics',{...current,title:source.title,startEntryId:defaultEntry?.id,sourceUrl:source.url});
      await tx.put('catalogs',{...source,comicId:comic.id});
    });
    return (await catalog.get('comics',comic.id))!;
  });
}
export async function importManifest(manifest:PageManifest) {
  return sourceLock(async()=>{
    const {location}=validateManifest(manifest);
    const comic=await websiteComic(manifest.url,manifest.title);
    let [entry]=await catalog.list('entries',{index:'sourceEntry',range:[comic.id,location.pageKey],limit:1});
    if(!entry) {
      const now=Date.now();entry={id:crypto.randomUUID(),comicId:comic.id,title:manifest.title,order:0,format:'website',contentId:crypto.randomUUID(),generation:1,indexState:'pending',sourceEntryId:location.pageKey,sourceUrl:manifest.url,createdAt:now,updatedAt:now};
      await catalog.commit([{table:'entries',value:entry}],{require:[{table:'comics',id:comic.id}]});
      if(!location.catalog)await catalog.patch('comics',comic.id,{startEntryId:entry.id});
    }
    await publishWebsiteManifest(entry,manifest);
    return {id:entry.id,comicId:comic.id,catalogUrl:location.catalog?.url};
  });
}
export async function publishWebsiteManifest(entry:Entry,manifest:PageManifest,acceptChange=false) {
  const {location}=validateManifest(manifest);
  if(entry.sourceEntryId!==location.pageKey)throw Error('来源页面不属于此漫画内容。');
  const old=await catalog.listPages(entry.contentId,{limit:1500});
  const changed=manifest.discoveryComplete&&old.length>manifest.items.length||old.some((page,index)=>{const incoming=manifest.items[index];return incoming&&(page.locator.url!==incoming.url||page.locator.sourceId!==incoming.id);});
  const pages:IndexedPage[]=manifest.items.map((page,ordinal)=>({ordinal,name:`第 ${ordinal+1} 页`,width:page.width||undefined,height:page.height||undefined,locator:{url:page.url,sourceId:page.id,manifestId:manifest.id,...(page.kind?{kind:page.kind}:{})}}));
  if(changed||acceptChange&&old.length>0) {
    if(!acceptChange)throw Error('来源内容已变化，请重新载入当前内容。');
    const contentId=crypto.randomUUID();await catalog.replaceContent(entry.id,entry.generation,{contentId,format:'website'},descriptors(contentId,pages),manifest.discoveryComplete,manifest.knownTotal);
    await Promise.all([sourcePageCache.deleteOwner(entry.id),sourceRangeCache.deleteOwner(entry.id),thumbnailCache.deleteOwner(entry.id),downloadStore.deleteOwner(entry.id)]);return;
  }
  for(let i=pages.length;i<old.length;i++)pages.push({...old[i],locator:old[i].locator as IndexedPage['locator']});
  await publishIndex(entry,pages,manifest.discoveryComplete,manifest.knownTotal);
}
function validateManifest(manifest:PageManifest) {
  const resolved=requireWebsite(manifest.url,manifest.adapter);
  if(resolved.location.kind!=='reader'||!manifest.items.length||manifest.items.length>1500||new Set(manifest.items.map(p=>p.id)).size!==manifest.items.length||manifest.items.some(p=>typeof p.id!=='string'||!p.id||!(p.kind==='page'?isPageImageUrl(p.url):safeImageUrl(p.url,manifest.url)===p.url)))throw Error('来源页面清单无效。');
  return resolved;
}
