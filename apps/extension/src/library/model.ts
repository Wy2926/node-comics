import { msg } from '../i18n/runtime';
import type { Page, ReadingCopy } from '../types';
import type { ImportAssignment, LibraryState, SourceEntry } from './types';
export const emptyLibrary=():LibraryState=>({id:'library',revision:0,works:[],chapters:[],versions:[],series:[],publications:[],inclusions:[],publicationRelations:[],coverage:[],relations:[],catalogs:[],tasks:[]});
export const makeCopy=(title:string,pages:Page[],source=msg("本地导入"),sourceKey:string=crypto.randomUUID()):ReadingCopy=>({id:crypto.randomUUID(),title,source,sourceKey,manifestRevision:1,retention:'offline',createdAt:Date.now(),updatedAt:Date.now(),pages,pageId:pages[0]?.id??'',relativeOffset:0,discoveryComplete:true});
// A manually imported selection is a fixed reading copy, even if the source page can discover more images.
// Only catalog acquisition (sourceEntryId) can still expand its page manifest in the background.
export const copyPageTotal=(copy:ReadingCopy):number|undefined=>copy.sourceEntryId?copy.knownTotal??(copy.discoveryComplete?copy.pages.length:undefined):copy.pages.length;
export const completePageList=(copy:ReadingCopy)=>copy.pages.length>0&&(!copy.sourceEntryId||copy.discoveryComplete&&copy.pages.length>=(copy.knownTotal??0));
export function attachCopy(state:LibraryState,copy:ReadingCopy,assignment:ImportAssignment){
 const stamp=Date.now(),evidence={status:'user' as const,source:msg("用户导入确认")};
 let work=state.works.find(w=>w.id===assignment.workId);
 if(assignment.workId&&!work)throw Error(msg("目标作品已移除，请重新选择。"));
 if(!work){work={id:crypto.randomUUID(),title:assignment.title.trim()||copy.title,aliases:[],creators:[],createdAt:stamp,updatedAt:stamp,evidence};state.works.push(work);}
 work.updatedAt=stamp;
 if(copy.versionId&&!state.versions.some(v=>v.id===copy.versionId&&v.workId===work.id))copy.versionId=undefined;
 let target:LibraryState['coverage'][number]['target']={kind:assignment.kind==='work'?'work':'unclassified',id:work.id};
 if(assignment.kind==='chapter'||assignment.kind==='extra'){
   let chapter=assignment.targetId?state.chapters.find(c=>c.id===assignment.targetId&&c.workId===work.id):undefined;
   if(assignment.targetId&&!chapter)throw Error(msg("所选章节不属于目标作品。"));
   if(!chapter){chapter={id:crypto.randomUUID(),workId:work.id,title:copy.title,number:assignment.number,numbering:msg("用户导入序列"),order:state.chapters.filter(c=>c.workId===work.id).length,role:assignment.kind==='extra'?'extra':'unknown',evidence};state.chapters.push(chapter);}
   target={kind:'chapter',id:chapter.id};
 }else if(assignment.kind==='publication'){
   let book=assignment.targetId?state.publications.find(p=>p.id===assignment.targetId&&p.workIds.includes(work.id)):undefined;
   if(assignment.targetId&&!book)throw Error(msg("所选卷册不属于目标作品。"));
   if(assignment.seriesId&&!state.series.some(s=>s.id===assignment.seriesId&&s.workIds.includes(work.id)))throw Error(msg("出版套系不属于目标作品。"));
   if(!book){book={id:crypto.randomUUID(),workIds:[work.id],seriesId:assignment.seriesId,title:copy.title,number:assignment.number,order:state.publications.length,form:'book',evidence};state.publications.push(book);}
   target={kind:'publication',id:book.id};
 }
 state.coverage.push({id:crypto.randomUUID(),copyId:copy.id,workId:work.id,target,evidence});
 return work.id;
}
export function suggestedKind(entry:SourceEntry):ImportAssignment['kind']{
 return entry.related?'unclassified':entry.suggestedKind??'unclassified';
}
export function selectRange<T extends {id:string}>(items:T[],first:string,last:string):string[]{
 const a=items.findIndex(i=>i.id===first),b=items.findIndex(i=>i.id===last);
 if(a<0||b<0)throw Error(msg("范围端点已不在当前目录中。"));
 return items.slice(Math.min(a,b),Math.max(a,b)+1).map(i=>i.id);
}
export function validateLibrary(s:LibraryState){
 const unique=(ids:string[])=>new Set(ids).size===ids.length;
 for(const collection of [s.works,s.chapters,s.versions,s.series,s.publications,s.inclusions,s.publicationRelations,s.coverage,s.relations,s.catalogs,s.tasks])if(!unique(collection.map(x=>x.id)))throw Error(msg("对象身份重复。"));
 const work=(id:string)=>s.works.some(w=>w.id===id),book=(id:string)=>s.publications.some(p=>p.id===id);
 if(s.series.some(e=>!e.workIds.length||e.workIds.some(id=>!work(id)))||s.versions.some(v=>!work(v.workId)||v.chapterId&&!s.chapters.some(c=>c.id===v.chapterId&&c.workId===v.workId))||s.relations.some(r=>!work(r.fromId)||!work(r.toId)||r.fromId===r.toId))throw Error(msg("版本或作品关联无效。"));
 if(s.chapters.some(c=>!work(c.workId))||s.coverage.some(c=>!work(c.workId))||s.publications.some(p=>p.workIds.some(id=>!work(id))||p.seriesId&&!s.series.some(e=>e.id===p.seriesId)))throw Error(msg("关联对象已不存在。"));
 for(const r of s.publicationRelations){if(!book(r.fromId)||!book(r.toId))throw Error(msg("关联卷册不存在。"));const visited=new Set<string>();const reach=(id:string):boolean=>id===r.fromId||!visited.has(id)&&(visited.add(id),s.publicationRelations.filter(x=>x.fromId===id).some(x=>reach(x.toId)));if(reach(r.toId))throw Error(msg("出版物收录／再版关系不能形成循环。"));}
 for(const i of s.inclusions){if(!book(i.publicationId)||!(i.target.kind==='work'?work(i.target.id):s.chapters.some(c=>c.id===i.target.id)))throw Error(msg("收录对象不存在。"));}
 for(const c of s.coverage){if(c.target.kind==='chapter'&&!s.chapters.some(x=>x.id===c.target.id&&x.workId===c.workId)||c.target.kind==='publication'&&!s.publications.some(p=>p.id===c.target.id&&p.workIds.includes(c.workId))||['work','unclassified'].includes(c.target.kind)&&c.target.id!==c.workId)throw Error(msg("副本归属无效。"));}
}
