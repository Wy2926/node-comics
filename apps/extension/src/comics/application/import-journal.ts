import {catalog} from '../repositories';
export interface LocalImportJournal {
  id:string;contentId:string;file:{name:string;size:number;containerId?:string};
  state:'copying'|'bytes-ready';updatedAt:number;[key:string]:unknown;
}
export const importJournalId=(contentId:string)=>'local-import:'+contentId;
export async function beginImportJournal(contentId:string,file:File):Promise<LocalImportJournal> {
  const journal:LocalImportJournal={id:importJournalId(contentId),contentId,file:{name:file.name,size:file.size},state:'copying',updatedAt:Date.now()};
  await catalog.put('metadata',journal);return journal;
}
export async function recordCopiedFile(journal:LocalImportJournal,containerId:string) {
  journal.file.containerId=containerId;journal.state='bytes-ready';journal.updatedAt=Date.now();await catalog.put('metadata',journal);
}
export const completeImportJournal=(contentId:string)=>catalog.remove('metadata',importJournalId(contentId));
