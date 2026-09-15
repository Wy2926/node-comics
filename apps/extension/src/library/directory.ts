import type {ReadingCopy} from '../types';
import type {LibraryState} from './types';
import {mangaCopyLocation} from '../sources/mangacopy';

export interface DirectoryEntry {
 id:string;title:string;number?:string;kind:'chapter'|'publication'|'copy';group:string;
 copyId?:string;pageId?:string;current:boolean;read:boolean;available:number;total?:number;
 status:string;error?:string;
}
export interface ReadingDirectory {title:string;entries:DirectoryEntry[];catalogUrl?:string;catalogCount:number;}

/** Content identity defines the directory; source/version only rank reading copies. */
export function readingDirectory(state:LibraryState,copies:ReadingCopy[],current:ReadingCopy):ReadingDirectory {
 const coverage=state.coverage.find(c=>c.copyId===current.id);
 const work=state.works.find(w=>w.id===coverage?.workId);
 const catalogs=state.catalogs.filter(c=>!!work&&c.workId===work.id);
 const entries:DirectoryEntry[]=[];
 const content=[...state.chapters.filter(c=>c.workId===work?.id).sort((a,b)=>a.order-b.order),...state.publications.filter(p=>p.workIds.includes(work?.id??'')).sort((a,b)=>a.order-b.order)];
 for(const item of content){
  const kind='role' in item?'chapter':'publication';
  const matches=state.coverage.filter(c=>c.workId===work?.id&&c.target.kind===kind&&c.target.id===item.id);
  const options=copies.filter(c=>matches.some(m=>m.copyId===c.id));
  const rank=(c:ReadingCopy)=>Number(c.id===current.id)*100+Number(c.versionId===current.versionId)*20+Number(c.source===current.source)*10+Number(c.pages.some(p=>p.blobKey))*5;
  const chosen=options.sort((a,b)=>rank(b)-rank(a)||(b.lastReadAt??0)-(a.lastReadAt??0)||b.manifestRevision-a.manifestRevision||a.id.localeCompare(b.id))[0];
  const match=matches.find(m=>m.copyId===chosen?.id),task=state.tasks.find(t=>t.copyId===chosen?.id);
  const available=chosen?.pages.filter(p=>p.blobKey).length??0;
  const total=chosen?.knownTotal??(chosen?.discoveryComplete?chosen.pages.length:undefined);
  const active=task&&['queued','running'].includes(task.status);
  const status=!chosen?'未添加副本':active?(task.phase==='discover'?'发现页面中':'采集中'):task?.status==='failed'?'采集失败':task?.status==='paused'?'已暂停':available?(chosen?.discoveryComplete&&available===chosen.pages.length?'可阅读':'部分可读'):chosen.sourceEntryId?'待采集':'待导入原图';
  const group='role' in item?(item.role==='extra'?'番外':'章节'):state.series.find(s=>s.id===item.seriesId)?.title??'卷册';
  entries.push({id:item.id,title:item.title,number:item.number,kind,group,copyId:chosen?.id,pageId:match?.startPageId,current:chosen?.id===current.id&&coverage?.target.id===item.id,read:!!item.readAt,available,total,status,error:task?.error});
 }
 if(!entries.some(e=>e.current))entries.unshift({id:current.id,title:current.title,kind:'copy',group:'当前副本',copyId:current.id,current:true,read:false,available:current.pages.filter(p=>p.blobKey).length,total:current.knownTotal??current.pages.length,status:'阅读中'});
 const location=current.sourceUrl?mangaCopyLocation(current.sourceUrl):null;
 return {title:work?.title??current.title,entries,catalogUrl:catalogs[0]?.url??(location?new URL('/comic/'+location.slug,current.sourceUrl).href:undefined),catalogCount:catalogs.reduce((n,c)=>n+c.entries.length,0)};
}
