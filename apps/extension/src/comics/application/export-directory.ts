import {msg} from '../../i18n/runtime';
import {MAX_EXPORT_PAGES,planExport,type ExportOptions,type ExportPlan} from '../../export/plan';
import type {ExportProgress} from '../../export/files';
import type {TranslationScope} from '../../translation/channels/contracts';
import {catalog} from '../repositories';
import {comicDirectory} from './library-service';
import {entrySource} from './entry-source';
import {prepareEntryContent} from './entry-content';
import {readWebsiteCatalog} from './website-catalog';
import {reconcileCatalog} from './catalog-service';
import type {SourceCatalog} from './types';

/** Preview local metadata only; opening the dialog never discovers chapters or reads images. */
export async function exportDirectoryInfo(entryId:string,language:string) {
  const entry=await catalog.get('entries',entryId);
  if(!entry)throw Error(msg('漫画已移除。'));
  if((await catalog.listEntries(entry.comicId,{offset:MAX_EXPORT_PAGES,limit:1})).length)throw Error(msg('整目录导出最多支持 10000 页，请改为逐章导出。'));
  const directory=await comicDirectory(entry.comicId,entryId,language);
  const [source]=await catalog.list('catalogs',{index:'comicId',range:entry.comicId,limit:1}) as unknown as SourceCatalog[];
  return {...directory,complete:directory.complete!==false&&source?.groups.every(group=>group.complete)!==false};
}

/** Freeze a bounded metadata plan. Chapter discovery is serial and never changes reading choices. */
export async function planDirectoryExport(entryId:string,options:ExportOptions,context:{signal:AbortSignal;scope?:TranslationScope;progress?:(value:ExportProgress)=>void;assertCurrent():Promise<void>|void}):Promise<ExportPlan> {
  const {signal,scope,progress,assertCurrent}=context;
  const binding=await entrySource(entryId,undefined,signal);
  let directory=await exportDirectoryInfo(entryId,options.language);
  if(!directory.complete) {
    progress?.({completed:0,total:0,file:directory.title,phase:msg('正在补齐章节目录…')});
    if(!binding.comic.sourceUrl)throw Error(msg('章节目录尚未完整加载，请先补齐目录后重试。'));
    const source=await readWebsiteCatalog(binding.comic.sourceUrl,signal);
    await assertCurrent();await binding.assertCurrent();
    if(!source.complete||source.groups.some(group=>!group.complete))throw Error(msg('章节目录尚未完整加载，请先补齐目录后重试。'));
    await catalog.mutate(['comics','entries','catalogs','connections'],async tx=>{
      signal.throwIfAborted();
      const comic=await tx.get('comics',binding.comic.id),connection=await tx.get('connections',binding.connection.id);
      if(!comic||comic.source.generation!==binding.comic.source.generation||comic.source.status!=='active'||!connection||connection.generation!==binding.connection.generation||['disconnected','revoked'].includes(connection.status))throw new DOMException('Source changed','AbortError');
      await reconcileCatalog(tx,comic,source);
    });
    directory=await exportDirectoryInfo(entryId,options.language);
    if(!directory.complete)throw Error(msg('章节目录尚未完整加载，请先补齐目录后重试。'));
  }
  if(!directory.chapters.length)throw Error(msg('目录中没有可导出的章节。'));
  if(directory.chapters.length>MAX_EXPORT_PAGES)throw Error(msg('整目录导出最多支持 10000 页，请改为逐章导出。'));
  const plan:ExportPlan={entryId,contentId:binding.entry.contentId,generation:binding.entry.generation,title:directory.title,createdAt:new Date().toISOString(),
    options:{...options,range:'directory',allowIncomplete:false},pages:[],chapters:[],incomplete:false,scope};
  // Capture every selected content identity before any asynchronous discovery.
  const entries=new Map((await catalog.listEntries(binding.comic.id)).map(entry=>[entry.id,entry]));
  for(const [index,chapter] of directory.chapters.entries()) {
    await assertCurrent();await binding.assertCurrent();
    const entry=entries.get(chapter.selectedEntryId);
    if(!entry||!chapter.readable||entry.format==='epub')throw Error(msg('章节「{0}」暂不可导出，请检查来源后重试。',{'0':chapter.title}));
    progress?.({completed:index,total:directory.chapters.length,file:chapter.title,phase:msg('准备第 {0} / {1} 章',{'0':index+1,'1':directory.chapters.length})});
    try {
      await prepareEntryContent(entry.id,signal);
      await assertCurrent();
      const part=await planExport(entry.id,plan.options,scope,signal);
      if(part.contentId!==entry.contentId||part.generation!==entry.generation)throw Error(msg('来源内容已变化，本次导出已停止。'));
      if(plan.pages.length+part.pages.length>MAX_EXPORT_PAGES)throw Error(msg('整目录导出最多支持 10000 页，请改为逐章导出。'));
      const firstPage=plan.pages.length;
      plan.chapters!.push({entryId:entry.id,contentId:part.contentId,generation:part.generation,title:chapter.title,firstPage,pageCount:part.pages.length});
      for(const page of part.pages)plan.pages.push({...page,ordinal:plan.pages.length,chapter:index});
    }catch(error) {
      signal.throwIfAborted();
      if(error instanceof Error&&error.name==='AbortError')throw error;
      throw Error(msg('章节「{0}」导出失败：{1}',{'0':chapter.title,'1':error instanceof Error?error.message:String(error)}));
    }
  }
  plan.expectedPages=plan.pages.length;
  await assertCurrent();await binding.assertCurrent();
  return plan;
}
