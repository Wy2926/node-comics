import type {SourceCatalog,SourceEntry} from '../library/types';
export const MANGACOPY_HOST='www.mangacopy.com';
export function mangaCopyLocation(value:string):{slug:string;chapterId?:string}|null{
 try{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!==MANGACOPY_HOST||u.port||u.username||u.password)return null;const m=u.pathname.match(/^\/comic\/([a-zA-Z0-9_-]+)(?:\/chapter\/([a-f0-9-]{36}))?\/?$/);return m?{slug:m[1],chapterId:m[2]}:null;}catch{return null;}
}
export function discoverMangaCopyCatalog(doc:Document,url:string):SourceCatalog{
 const location=mangaCopyLocation(url);if(!location||location.chapterId)throw Error('请从 MangaCopy 漫画详情页导入作品。');
 const id=`mangacopy:${location.slug}`,entries=new Map<string,SourceEntry>();
 const tables=[...doc.querySelectorAll('.upLoop > .table-default')];
 let complete=tables.length>0&&!doc.querySelector('.upLoop .wargin');
 const groups=tables.map(table=>{
  const panel=[...table.querySelectorAll('.tab-pane')].find(p=>p.id.endsWith('全部'));
  const groupId=panel?.id.slice(0,-2)??'',title=table.previousElementSibling?.textContent?.trim()||groupId;
  const links=[...panel?.querySelectorAll<HTMLAnchorElement>('a[href*="/chapter/"]')??[]];
  // Empty tab panels can be inserted before the asynchronous directory links.
  // Their presence alone does not establish a complete source catalog.
  let valid=!!groupId&&links.length>0;const entryIds:string[]=[];
  for(const [order,a] of links.entries()){
   const href=new URL(a.getAttribute('href')??'',url).href,loc=mangaCopyLocation(href);
   if(!loc?.chapterId||loc.slug!==location.slug){valid=false;continue;}
   const entryId=`${id}:${loc.chapterId}`;
   const rawTypes=[...table.querySelectorAll('.tab-pane')].filter(p=>p!==panel&&[...p.querySelectorAll('a[href*="/chapter/"]')].some(link=>link.getAttribute('href')===a.getAttribute('href'))).map(p=>p.id.slice(groupId.length));
   const existing=entries.get(entryId);
   if(existing){existing.groupIds=[...new Set([...existing.groupIds,groupId])];existing.rawTypes=[...new Set([...existing.rawTypes,...rawTypes])];}else entries.set(entryId,{id:entryId,catalogId:id,remoteId:loc.chapterId,url:href,title:(a.getAttribute('title')||a.textContent||'未命名条目').trim().slice(0,180),groupIds:[groupId],rawTypes,order,related:/同人|其他系列|其它系列/.test(title)});
   if(!entryIds.includes(entryId))entryIds.push(entryId);
  }
  // The site's current renderer inserts every item; pagination only changes display.
  if(!panel||new Set(links.map(a=>a.getAttribute('href'))).size!==entryIds.length)valid=false;
  if(!valid)complete=false;
  return {id:groupId,title,entryIds,complete:valid};
 });
 return {id,sourceId:'mangacopy',url:`https://${MANGACOPY_HOST}/comic/${location.slug}`,title:doc.querySelector('.comicParticulars-title-right h6')?.textContent?.trim()||doc.querySelector('h6')?.textContent?.trim()||doc.title.split(' - ')[0],observedAt:Date.now(),complete,note:complete?'已读取所有分组及隐藏分页条目。':'目录尚未就绪或结构发生变化；只能选择已发现条目。',groups,entries:[...entries.values()],excludedEntryIds:[]};
}
