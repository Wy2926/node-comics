import {sourceLock} from './locks';
import { catalog, type CatalogWrite } from '../repositories';
import type { Document, DocumentRevision, PageDescriptor } from '../domain';
import { importContainer, releaseContainer } from '../../storage/containers';
import { openDocument } from '../formats';
import type { ComicFormat, IndexedPage } from '../formats/contracts';
import { openFileSource } from '../sources/runtime';
import type { SourceSelection } from '../sources/contracts';
import type { ImportAssignment, SourceCatalog } from './types';
import type { PageManifest, SourceEntry } from '../../sources';
import { Sha256 } from '../../importers/hash';
import { beginImportJournal, completeImportJournal, recordCopiedFile } from './import-journal';
import { restoreSourceSelection } from './source-access';

const digest=(value:string)=>new Sha256().update(new TextEncoder().encode(value)).digest();
function validateAssignment(assignment:ImportAssignment){if(!assignment.workId&&!assignment.title.trim())throw Error('作品名称不能为空。');}
export const stablePageId=(revisionId:string,locator:unknown)=>digest(JSON.stringify([revisionId,locator]));
interface DocumentRegistration {title:string;format:Document['format'];sourceKey:string;connectionId:string;provider:string;providerItemId?:string;accountId?:string;displayName:string;locator:Record<string,unknown>;containerId?:string;sourceSnapshot?:Record<string,unknown>;revisionId?:string;sourceUrl?:string;sourceEntryId?:string}
export function registerDocument(input:DocumentRegistration,assignment:ImportAssignment):Promise<{document:Document;created:boolean}>{return registerDocumentAttempt(input,assignment,false);}
async function registerDocumentAttempt(input:DocumentRegistration,assignment:ImportAssignment,retried:boolean):Promise<{document:Document;created:boolean}>{
  validateAssignment(assignment);
  const existing=(await catalog.list('documents',{index:'sourceKey',range:input.sourceKey,limit:1}))[0];
  if(existing)return {document:existing,created:false};
  const providerItemId=input.providerItemId??input.sourceKey;
  const binding=(await catalog.list('bindings',{index:'providerItem',range:[input.connectionId,providerItemId],limit:1}))[0];
  const now=Date.now(),documentId=crypto.randomUUID(),revisionId=input.revisionId??crypto.randomUUID(),workId=assignment.workId??crypto.randomUUID(),unitId=assignment.unitId??crypto.randomUUID(),bindingId=binding?.id??crypto.randomUUID();
  if(assignment.workId&&!await catalog.get('works',workId))throw Error('所选作品已移除。');
  if(assignment.unitId){const unit=await catalog.get('units',unitId);if(!unit||unit.workId!==workId)throw Error('所选阅读单元不属于此作品。');}
  const document:Document={id:documentId,unitId,sourceBindingId:bindingId,format:input.format,revisionId,title:input.title,generation:1,indexState:'indexing',sourceKey:input.sourceKey,createdAt:now,updatedAt:now,sourceUrl:input.sourceUrl,sourceEntryId:input.sourceEntryId};
  const revision:DocumentRevision={id:revisionId,documentId,containerId:input.containerId,sourceSnapshot:input.sourceSnapshot,sourceVersion:typeof input.sourceSnapshot?.version==='string'?input.sourceSnapshot.version:undefined,parserVersion:'file-index-v1',indexVersion:1,generation:1,status:'indexing',createdAt:now};
  const records:CatalogWrite[]=[{table:'documents',value:document},{table:'revisions',value:revision}];
  if(!binding)records.push({table:'bindings',value:{id:bindingId,connectionId:input.connectionId,providerItemId,locator:input.locator,generation:1,createdAt:now,updatedAt:now}});
  if(!await catalog.get('connections',input.connectionId))records.push({table:'connections',value:{id:input.connectionId,provider:input.provider,accountId:input.accountId,displayName:input.displayName,status:'connected',generation:1,createdAt:now,updatedAt:now}});
  if(!assignment.workId)records.push({table:'works',value:{id:workId,title:assignment.title.trim()||input.title,aliases:[],createdAt:now,updatedAt:now}});
  if(!assignment.unitId)records.push({table:'units',value:{id:unitId,workId,title:input.title,order:now,kind:assignment.kind,role:assignment.role??'unknown',preferredDocumentId:documentId,createdAt:now,updatedAt:now}});
  try{await catalog.commit(records,{require:[{table:'works',id:workId},{table:'units',id:unitId},...(binding?[{table:'bindings' as const,id:bindingId}]:[])],incrementWorkDocuments:workId});}
  catch(error){
    const duplicate=(await catalog.list('documents',{index:'sourceKey',range:input.sourceKey,limit:1}))[0];if(duplicate)return {document:duplicate,created:false};
    if(!retried&&!binding&&(await catalog.list('bindings',{index:'providerItem',range:[input.connectionId,providerItemId],limit:1}))[0])return registerDocumentAttempt(input,assignment,true);
    throw error;
  }
  return {document,created:true};
}
async function publishIndex(doc:Document,pages:IndexedPage[],complete=true,knownTotal?:number){
  if(!pages.length&&complete)throw Error('文件中未找到可读漫画页面。');
  const descriptors:PageDescriptor[]=pages.map(page=>({...page,pageId:stablePageId(doc.revisionId,doc.format==='website'?{url:page.locator.url,sourceId:page.locator.sourceId}:page.locator),revisionId:doc.revisionId,formatLocator:JSON.stringify(doc.format==='website'?{url:page.locator.url,sourceId:page.locator.sourceId}:page.locator)}));
  for(let offset=0;offset<descriptors.length;offset+=100)await catalog.putPages(doc.id,doc.revisionId,descriptors.slice(offset,offset+100),doc.generation);
  if(!await catalog.finishIndex(doc.id,doc.revisionId,doc.generation,{pageCount:pages.length,knownTotal:knownTotal??(complete?pages.length:undefined),discoveryComplete:complete,coverPageId:descriptors[0]?.pageId}))throw Error('文档版本已改变，目录结果已丢弃。');
}
export async function reindexDocument(id:string,signal?:AbortSignal){
  signal?.throwIfAborted();
  let doc=await catalog.get('documents',id);if(!doc)throw Error('文档已移除。');
  if(doc.format==='website')throw Error('请通过网站来源重新发现页面。');
  const revision=await catalog.get('revisions',doc.revisionId);if(!revision)throw Error('文档版本已移除。');
  doc=await catalog.patch('documents',id,{indexState:'indexing',error:undefined,generation:doc.generation+1},{expectedGeneration:doc.generation});if(!doc)throw Error('文档已移除。');
  try{
    if(doc.format==='images'){
      const ids=revision.sourceSnapshot?.containerIds,names=revision.sourceSnapshot?.fileNames;
      if(!Array.isArray(ids)||!ids.length||ids.some(value=>typeof value!=='string'))throw Error('图集来源资料不完整，请重新导入。');
      signal?.throwIfAborted();
      const complete=revision.sourceSnapshot?.importComplete!==false;
      await publishIndex(doc,ids.map((containerId,ordinal)=>({ordinal,name:Array.isArray(names)&&typeof names[ordinal]==='string'?names[ordinal]:`第 ${ordinal+1} 页`,locator:{containerId,imageIndex:ordinal}})),complete,typeof revision.sourceSnapshot?.expectedPageCount==='number'?revision.sourceSnapshot.expectedPageCount:ids.length);
      if(!complete)await catalog.patch('documents',id,{indexState:'failed',error:'图集导入中断，已保存的原图保留；请重新选择完整图集。'},{expectedGeneration:doc.generation});
      return id;
    }
    const binding=await catalog.get('bindings',doc.sourceBindingId),connection=binding&&await catalog.get('connections',binding.connectionId);
    if(!binding||!connection)throw Error('来源连接已移除。');
    const source=await openFileSource({connection,binding,revision,documentId:doc.id,format:doc.format,containerId:revision.containerId,signal});
    try{const session=await openDocument(doc.format as ComicFormat,source,signal);try{await publishIndex(doc,await session.index(signal));}finally{await session.close();}}finally{await source.close();}
  }catch(error){await catalog.patch('documents',id,{indexState:'failed',error:(error as Error).message},{expectedGeneration:doc.generation}).catch(()=>{});throw error;}
  return id;
}
async function saveLocalFile(file:File,assignment:ImportAssignment,signal?:AbortSignal,onProgress?:(label:string,done?:number,total?:number)=>void){
  validateAssignment(assignment);
  const revisionId=crypto.randomUUID();
  const journal=await beginImportJournal(revisionId,'file',[file],assignment);
  onProgress?.('正在保存完整源文件',0,file.size);
  let container:Awaited<ReturnType<typeof importContainer>>|undefined,registered=false;
  try{
    container=await importContainer(file,signal,(done,total)=>onProgress?.('正在保存完整源文件',done,total),revisionId);
    await recordCopiedFile(journal,0,container.id);
    const result=await registerDocument({title:file.name.replace(/\.[^.]+$/,''),format:container.format,sourceKey:'local:'+container.id+':'+(assignment.unitId??assignment.workId??'new'),connectionId:'local',provider:'local',displayName:'本地源文件',locator:{containerId:container.id,name:file.name},containerId:container.id,revisionId},assignment);
    if(!result.created){await releaseContainer(container.id,revisionId);await completeImportJournal(revisionId);if(result.document.indexState!=='ready')await reindexDocument(result.document.id,signal);return {id:result.document.id,created:false};}
    registered=true;await completeImportJournal(revisionId);
    onProgress?.('源文件已保存，正在建立目录');
    await reindexDocument(result.document.id,signal);
    return {id:result.document.id,created:true};
  }catch(error){if(!registered&&container)await releaseContainer(container.id,revisionId);await completeImportJournal(revisionId).catch(()=>{});throw error;}
}
export async function importSourceFiles(selection:SourceSelection,assignment:ImportAssignment,signal?:AbortSignal){
  signal?.throwIfAborted();
  validateAssignment(assignment);
  await restoreSourceSelection(selection);
  const ids:string[]=[];let sharedWork=assignment.workId;
  for(const file of selection.files){
    signal?.throwIfAborted();
    const result=await registerDocument({title:file.name.replace(/\.[^.]+$/,''),format:file.format,sourceKey:file.sourceKey,providerItemId:file.id,connectionId:selection.connection.id,provider:selection.connection.provider,accountId:selection.connection.accountId,displayName:selection.connection.displayName,locator:file.locator,sourceSnapshot:file.snapshot}, {...assignment,workId:sharedWork});
    const unit=await catalog.get('units',result.document.unitId);sharedWork??=unit?.workId;
    if(result.created||result.document.indexState!=='ready')await reindexDocument(result.document.id,signal);ids.push(result.document.id);
  }return ids;
}
export async function importWebsiteEntry(source:SourceCatalog,entry:SourceEntry,assignment:ImportAssignment){
  const result=await registerDocument({title:entry.title,format:'website',sourceKey:'website:'+entry.id,connectionId:'website:'+source.sourceId,provider:'website',displayName:source.title,locator:{catalogId:source.id,entryId:entry.id,url:entry.url},sourceUrl:entry.url,sourceEntryId:entry.id},assignment);
  const unit=await catalog.get('units',result.document.unitId);
  await catalog.put('catalogs',{...source,workId:unit?.workId});
  // Discovery stays pending until explicitly opening or downloading this document.
  return result.document.id;
}
export async function importManifest(manifest:PageManifest,assignment:ImportAssignment){
  const sourceKey='website-selection:'+digest(JSON.stringify([manifest.url,manifest.items.map(p=>p.id)]));
  const result=await registerDocument({title:manifest.title,format:'website',sourceKey,connectionId:'website:'+manifest.adapter,provider:'website',displayName:manifest.adapter,locator:{url:manifest.url},sourceUrl:manifest.url},assignment);
  if(result.created)await publishWebsiteManifest(result.document,manifest);
  return result.document.id;
}
export async function publishWebsiteManifest(doc:Document,manifest:PageManifest){
  const old=await catalog.listPages(doc.revisionId,{limit:1500});
  for(const [index,page] of old.entries()){const incoming=manifest.items[index];if(incoming&&(page.locator.url!==incoming.url||page.locator.sourceId!==incoming.id))throw Error('来源页序或地址已变化，请导入新的文档版本。');}
  const pages:IndexedPage[]=manifest.items.map((p,index)=>({ordinal:index,name:`第 ${index+1} 页`,width:p.width||undefined,height:p.height||undefined,locator:{url:p.url,sourceId:p.id,manifestId:manifest.id,...(p.kind?{kind:p.kind}:{})}}));
  // A restarted discovery may report a shorter prefix. Do not truncate saved suffix pages.
  for(let i=pages.length;i<old.length;i++)pages.push({...old[i],locator:old[i].locator as {url:string;sourceId:string}});
  await publishIndex(doc,pages,manifest.discoveryComplete,manifest.knownTotal);
}

async function saveImageAlbum(files:File[],assignment:ImportAssignment,signal?:AbortSignal,onProgress?:(label:string,done?:number,total?:number)=>void){
  validateAssignment(assignment);
  if(!files.length)throw Error('请选择至少一张图片。');
  const revisionId=crypto.randomUUID(),containers:Awaited<ReturnType<typeof importContainer>>[]=[];let registered=false;
  const journal=await beginImportJournal(revisionId,'images',files,assignment);
  try{
    for(const [index,file] of files.entries()){onProgress?.(`正在保存原图 ${index+1} / ${files.length}`,index,files.length);const container=await importContainer(file,signal,undefined,revisionId);containers.push(container);await recordCopiedFile(journal,index,container.id);}
    const result=await registerDocument({title:files[0].name.replace(/\.[^.]+$/,''),format:'images',sourceKey:'album:'+digest(JSON.stringify(containers.map(c=>c.id)))+':'+(assignment.unitId??assignment.workId??'new'),connectionId:'local',provider:'local',displayName:'本地图集',locator:{},sourceSnapshot:{containerIds:containers.map(c=>c.id),fileNames:files.map(f=>f.name),importComplete:true},revisionId},assignment);
    if(!result.created){for(const c of containers)await releaseContainer(c.id,revisionId);await completeImportJournal(revisionId);if(result.document.indexState!=='ready')await reindexDocument(result.document.id,signal);return {id:result.document.id,created:false};}
    registered=true;
    await completeImportJournal(revisionId);
    await reindexDocument(result.document.id,signal);
    return {id:result.document.id,created:true};
  }catch(error){if(!registered)for(const c of containers)await releaseContainer(c.id,revisionId);await completeImportJournal(revisionId).catch(()=>{});throw error;}
}

export const importLocalFile=(...args:Parameters<typeof saveLocalFile>)=>sourceLock(()=>saveLocalFile(...args));
export const importImageAlbum=(...args:Parameters<typeof saveImageAlbum>)=>sourceLock(()=>saveImageAlbum(...args));
