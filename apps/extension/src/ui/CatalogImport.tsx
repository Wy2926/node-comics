import { useEffect, useMemo, useRef, useState } from 'react';
import { msg } from '../i18n/runtime';
import { queueCopies } from '../library/acquisition';
import { makeCopy, selectRange, suggestedKind } from '../library/model';
import { commitCopies } from '../library/store';
import type { ImportAssignment, LibraryState, SourceCatalog, SourceEntry } from '../library/types';
import { requestImagePermissions, sourceName } from '../sources';
import type { ReadingCopy } from '../types';
import './catalog.css';
import { Select } from './Select';
import { useImagePermissions } from './useImagePermissions';

const PAGE_SIZE=40;
const kinds:Record<ImportAssignment['kind'],string>={get chapter(){return msg("章节");},get extra(){return msg("番外");},get publication(){return msg("卷册");},get unclassified(){return msg("待整理");},get work(){return msg("独立作品");}};
type Props={catalog:SourceCatalog;library:LibraryState;copies:ReadingCopy[];onClose:()=>void;onDone:()=>void;onRefresh:()=>void|Promise<void>;onNotice?:(message:string)=>void};

export function CatalogImport({catalog,library,copies,onClose,onDone,onRefresh,onNotice}:Props){
 const previous=library.catalogs.find(c=>c.id===catalog.id);
 const already=useMemo(()=>new Set(copies.map(c=>c.sourceEntryId)),[copies]);
 const excluded=useMemo(()=>new Set(previous?.excludedEntryIds),[previous]);
 const [group,setGroup]=useState(catalog.groups[0]?.id??'');
 const [type,setType]=useState(''),[query,setQuery]=useState(''),[status,setStatus]=useState('all'),[sort,setSort]=useState('source');
 const [page,setPage]=useState(0),[confirmPage,setConfirmPage]=useState(0);
 const [selected,setSelected]=useState(()=>{
  try{const ids=JSON.parse(localStorage.getItem('nc-catalog-selection:'+catalog.id)??'null');if(Array.isArray(ids))return new Set<string>(ids.filter(id=>catalog.entries.some(e=>e.id===id)&&!excluded.has(id)));}catch{}
  return new Set((catalog.groups[0]?.entryIds??catalog.entries.map(e=>e.id)).filter(id=>!excluded.has(id)&&!already.has(id)));
 });
 const [rangeMode,setRangeMode]=useState(false),[rangeStart,setRangeStart]=useState<string>();
 const lastClicked=useRef<string|undefined>(undefined),saving=useRef(false);
 const [offline,setOffline]=useState(false),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false);
 const [error,setError]=useState(''),[feedback,setFeedback]=useState('');
 const [assignment,setAssignment]=useState<ImportAssignment>({workId:previous?.workId,title:catalog.title,kind:'unclassified'});
 const [workQuery,setWorkQuery]=useState(''),[overrides,setOverrides]=useState<Record<string,ImportAssignment['kind']>>({});
 useEffect(()=>{try{localStorage.setItem('nc-catalog-selection:'+catalog.id,JSON.stringify([...selected]));}catch{/* Selection remains available for this visit when storage is full. */}},[catalog.id,selected]);
 const filtered=useMemo(()=>{
  const entries=catalog.entries.filter(e=>(!group||e.groupIds.includes(group))&&(!type||e.rawTypes.includes(type))&&(!query.trim()||e.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))&&(status==='all'||status==='new'&&!already.has(e.id)&&!excluded.has(e.id)||status==='imported'&&already.has(e.id)||status==='removed'&&excluded.has(e.id)&&!already.has(e.id)));
  return entries.sort((a,b)=>sort==='title'?a.title.localeCompare(b.title,'zh-CN',{numeric:true}):sort==='reverse'?b.order-a.order:a.order-b.order);
 },[catalog,group,type,query,status,sort,already,excluded]);
 const chosen=catalog.entries.filter(e=>selected.has(e.id));
 const permissions=useImagePermissions(offline&&chosen.length?[{catalog,entryId:chosen[0].id}]:[]);
 const visibleIds=new Set(filtered.map(e=>e.id)),hiddenSelected=chosen.filter(e=>!visibleIds.has(e.id)).length;
 const added=catalog.entries.filter(e=>!previous?.entries.some(p=>p.id===e.id)).length;
 const changed=catalog.entries.filter(e=>previous?.entries.some(p=>p.id===e.id&&(p.title!==e.title||p.rawTypes.join()!==e.rawTypes.join()))).length;
 const newCount=chosen.filter(e=>!already.has(e.id)).length,relatedCount=chosen.filter(e=>e.related&&!already.has(e.id)).length;
 const destination=assignment.workId?library.works.find(w=>w.id===assignment.workId)?.title??msg("作品已移除"):assignment.title.trim()||msg("未命名作品");
 const needsDestination=chosen.some(e=>!e.related&&!already.has(e.id));
 const assignmentValid=!needsDestination||!!(assignment.workId?library.works.some(w=>w.id===assignment.workId):assignment.title.trim());
 const activePage=Math.min(page,Math.max(0,Math.ceil(filtered.length/PAGE_SIZE)-1));
 const reviewPage=Math.min(confirmPage,Math.max(0,Math.ceil(chosen.length/PAGE_SIZE)-1));
 const rangeLabel=rangeStart?catalog.entries.find(e=>e.id===rangeStart)?.title:undefined;
 function filterChanged(change:()=>void){change();setPage(0);setRangeStart(undefined);lastClicked.current=undefined;setFeedback(msg("已更新显示范围，原有选择已保留。"));}
 function select(ids:string[],add=true){setSelected(prev=>{const next=new Set(prev);for(const id of ids)add?next.add(id):next.delete(id);return next;});}
 function toggleEntry(entry:SourceEntry,shiftKey:boolean){
  if(rangeMode){
   if(!rangeStart){setRangeStart(entry.id);setFeedback(msg("已标记起点「{0}」，请选择终点，可翻页。", {"0": entry.title}));return;}
   const ids=selectRange(filtered,rangeStart,entry.id);select(ids);setRangeStart(undefined);setRangeMode(false);setFeedback(msg("已选中连续 {0} 项。", {"0": ids.length}));
  }else if(shiftKey&&lastClicked.current&&visibleIds.has(lastClicked.current)){
   const ids=selectRange(filtered,lastClicked.current,entry.id);select(ids);setFeedback(msg("已选中连续 {0} 项。", {"0": ids.length}));
  }else{select([entry.id],!selected.has(entry.id));setFeedback((selected.has(entry.id)?msg("已取消「"):msg("已选择「"))+entry.title+'」。');}
  lastClicked.current=entry.id;
 }
 async function refresh(){if(refreshing)return;setRefreshing(true);setError('');setFeedback(msg("正在读取最新来源目录…"));try{await onRefresh();setFeedback(msg("已完成目录刷新。"));}catch(e){setError(e instanceof Error?e.message:msg("目录刷新失败，请重试。"));}finally{setRefreshing(false);}}
 async function submit(){
  if(saving.current||!chosen.length||!assignmentValid||permissions.preparing||permissions.error)return;
  saving.current=true;setBusy(true);setError('');setFeedback(msg("正在保存 {0} 个来源条目…", {"0": chosen.length}));
  try{
   if(offline)await requestImagePermissions([new URL(catalog.url).origin+'/*',...permissions.origins]);
   const incoming=chosen.map(entry=>({...makeCopy(entry.title,[],sourceName(catalog.sourceId),entry.id),sourceEntryId:entry.id,sourceUrl:entry.url,retention:offline?'offline' as const:'cache' as const,discoveryComplete:false}));
   const mappings=chosen.map(entry=>entry.related?{title:entry.title,kind:'unclassified' as const}:{...assignment,kind:overrides[entry.id]??suggestedKind(entry)});
   const result=await commitCopies(incoming,mappings,catalog);
   let message=msg("已导入 {0} 个新条目{1}。", {"0": result.created, "1": (chosen.length>result.created?msg("，保留 {0} 个已有条目", {"0": (chosen.length-result.created)}):'')});
   if(offline){
    try{await queueCopies(result.copyIds);message+=msg(" 原图将离线保留，待获取内容可在采集中心查看。");}
    catch(e){message+=msg(" 原图未加入队列：{0}", {"0": (e instanceof Error?e.message:msg("请在采集中心重试。"))});}
   }
   try{localStorage.removeItem('nc-catalog-selection:'+catalog.id);}catch{}
   onDone();onClose();onNotice?.(message);
  }catch(e){setError(e instanceof Error?e.message:msg("保存失败，请重试。"));setFeedback(msg("导入未完成，选择与归属已保留。"));}
  finally{saving.current=false;setBusy(false);}
 }
 function pagination(total:number,current:number,setCurrent:(page:number)=>void){return <nav className="nc-pagination" aria-label={confirm?msg("归属预览分页"):msg("来源目录分页")}><span>{msg("{0} 项 · 第 {1} / {2} 页", {"0": total, "1": current+1, "2": Math.max(1,Math.ceil(total/PAGE_SIZE))})}</span><button className="button secondary" disabled={current===0||busy} onClick={()=>setCurrent(current-1)}>{msg("上一页")}</button><button className="button secondary" disabled={(current+1)*PAGE_SIZE>=total||busy} onClick={()=>setCurrent(current+1)}>{msg("下一页")}</button></nav>;}
 return <section className="nc-catalog-import" aria-busy={busy||refreshing}>
  <div className="nc-page-heading"><div><span className="nc-eyebrow">{previous?msg("更新来源目录"):msg("导入来源目录")} · {confirm?msg("02 确认导入"):msg("01 选择内容")}</span><h1>{catalog.title}</h1><p>{confirm?msg("确认作品归属和保存方式，即可加入书架。"):msg("点击卡片选择要加入书架的内容，也可以跨页批量选择。")}</p></div><button className="button secondary" disabled={busy} onClick={onClose}>{msg("返回书架")}</button></div>
  <div className="nc-catalog-overview"><div><b>{catalog.entries.length}</b><span>{msg("已发现条目")}</span></div><div><b>{catalog.entries.filter(e=>already.has(e.id)).length}</b><span>{msg("已在书架")}</span></div><div><b>{catalog.groups.length}</b><span>{msg("来源分组")}</span></div><span className={'nc-catalog-completeness'+(!catalog.complete?' is-partial':'')}>{catalog.complete?msg("目录已读取完整"):msg("目录仍有待发现内容")}</span>{!confirm&&<button className="text-link" disabled={refreshing} onClick={()=>void refresh()}>{refreshing?msg("正在更新…"):msg("刷新目录")}</button>}</div>
  {!catalog.complete&&<div className="notice warning">{msg("当前只显示已发现条目，可以先导入这些内容，再刷新目录补齐。")}</div>}
  {previous&&<details className="nc-catalog-difference"><summary>{msg("目录变化：新增 {0} 项 · 标签更新 {1} 项", {"0": added, "1": changed})}</summary><p>{msg("{0} {1} 已移除的条目需要手动选择后才会恢复。", {"0": catalog.note, "1": catalog.complete?msg("未出现的旧条目继续保留。"):msg("当前目录不完整，不据此移除旧条目。")})}</p>{changed>0&&<div className="nc-catalog-change-grid">{catalog.entries.filter(e=>previous.entries.some(p=>p.id===e.id&&(p.title!==e.title||p.rawTypes.join()!==e.rawTypes.join()))).slice(0,12).map(e=><span key={e.id}>{previous.entries.find(p=>p.id===e.id)?.title} → {e.title}<small>{e.rawTypes.join(' / ')||msg("未分类")}</small></span>)}{changed>12&&<span>{msg("另有 {0} 项标签更新", {"0": changed-12})}</span>}</div>}</details>}
  {error&&<p role="alert" className="error-message">{error}</p>}
  {!confirm?<>
   <div className="nc-catalog-group-tabs" role="group" aria-label={msg("来源分组")}><button aria-pressed={!group} onClick={()=>filterChanged(()=>setGroup(''))}>{msg("全部分组")}<span>{catalog.entries.length}</span></button>{catalog.groups.map(g=><button key={g.id} aria-pressed={group===g.id} onClick={()=>filterChanged(()=>setGroup(g.id))}>{g.title} <span>{g.entryIds.length}</span></button>)}</div>
   <div className="nc-catalog-toolbar"><input className="nc-catalog-search" type="search" aria-label={msg("搜索来源条目")} placeholder={msg("搜索章节、番外或卷册…")} value={query} onChange={e=>filterChanged(()=>setQuery(e.target.value))}/><Select aria-label={msg("导入状态筛选")} value={status} onChange={e=>filterChanged(()=>setStatus(e.target.value))}><option value="all">{msg("全部状态")}</option><option value="new">{msg("未导入")}</option><option value="imported">{msg("已在书架")}</option><option value="removed">{msg("已移除")}</option></Select><Select aria-label={msg("原站类型")} value={type} onChange={e=>filterChanged(()=>setType(e.target.value))}><option value="">{msg("全部类型")}</option>{[...new Set(catalog.entries.flatMap(e=>e.rawTypes))].map(t=><option key={t}>{t}</option>)}</Select><Select aria-label={msg("来源条目排序")} value={sort} onChange={e=>filterChanged(()=>setSort(e.target.value))}><option value="source">{msg("来源顺序 · 正序")}</option><option value="reverse">{msg("来源顺序 · 倒序")}</option><option value="title">{msg("标题 · 自然排序")}</option></Select></div>
   <div className="nc-catalog-results"><span>{msg("当前显示 {0} 项", {"0": filtered.length})}</span><span>{hiddenSelected>0?msg("有 {0} 个已选条目在其他筛选中", {"0": hiddenSelected}):msg("切换筛选与排序会保留已选内容")}</span></div>
   {rangeMode&&<div className="notice nc-catalog-range-hint">{rangeStart?msg("起点：{0}。点击终点完成连续选择，可跨页。", {"0": rangeLabel}):msg("点击范围起点，再点击终点，按当前排序连续选择。")}<button className="text-link" onClick={()=>{setRangeMode(false);setRangeStart(undefined);setFeedback(msg("已取消范围选择。"));}}>{msg("取消范围选择")}</button></div>}
   {filtered.length?<div className="nc-catalog-grid" aria-label={msg("来源条目卡片")}>{filtered.slice(activePage*PAGE_SIZE,activePage*PAGE_SIZE+PAGE_SIZE).map(entry=><button className={'nc-catalog-card'+(selected.has(entry.id)?' is-selected':'')+(rangeStart===entry.id?' is-range-start':'')} key={entry.id} aria-pressed={selected.has(entry.id)} aria-label={entry.title+'，'+(already.has(entry.id)?msg("已在书架"):excluded.has(entry.id)?msg("已移除"):msg("未导入"))} onClick={event=>toggleEntry(entry,event.shiftKey)}><div className="nc-catalog-card-top"><span className="nc-catalog-kind">{kinds[suggestedKind(entry)]}</span><span className="nc-catalog-check" aria-hidden="true">{selected.has(entry.id)?'✓':'+'}</span></div><h3>{entry.title}</h3><p>{entry.groupIds.map(id=>catalog.groups.find(g=>g.id===id)?.title).filter(Boolean).join(' / ')||msg("未分组")}</p><div className="nc-catalog-card-foot"><span className={already.has(entry.id)?'is-imported':excluded.has(entry.id)?'is-removed':''}>{already.has(entry.id)?msg("已在书架"):excluded.has(entry.id)?msg("已移除 · 可恢复"):msg("未导入")}</span>{entry.related&&<span>{msg("独立归属")}</span>}</div></button>)}</div>:<div className="nc-catalog-empty"><b>{msg("没有符合条件的条目")}</b><p>{msg("调整搜索或筛选，已选内容仍然保留。")}</p><button className="button secondary" onClick={()=>filterChanged(()=>{setQuery('');setStatus('all');setType('');setGroup('');})}>{msg("清除筛选")}</button></div>}
   {pagination(filtered.length,activePage,setPage)}
   <div className="nc-catalog-actionbar"><div className="nc-catalog-selection-summary"><strong>{msg("已选 {0} 项", {"0": chosen.length})}</strong><span>{msg("{0} 项新内容{1}", {"0": newCount, "1": hiddenSelected?msg(" · 含其他筛选中 {0} 项", {"0": hiddenSelected}):''})}</span></div><div className="nc-catalog-batch-actions"><button className="text-link" disabled={!filtered.length||filtered.every(e=>selected.has(e.id))} onClick={()=>{select(filtered.map(e=>e.id));setFeedback(msg("已选中当前筛选的全部 {0} 项，包含其他分页。", {"0": filtered.length}));}}>{msg("全选当前结果（跨页）")}</button><button className="text-link" disabled={!filtered.length} aria-pressed={rangeMode} onClick={()=>{setRangeMode(!rangeMode);setRangeStart(undefined);setFeedback(rangeMode?msg("已退出范围选择。"):msg("请选择范围起点和终点。"));}}>{msg("连续范围")}</button><button className="text-link" disabled={!selected.size} onClick={()=>{setSelected(new Set());setFeedback(msg("已清空全部选择。"));}}>{msg("清空")}</button></div><button className="button primary" disabled={!chosen.length} onClick={()=>{setConfirm(true);setConfirmPage(0);setFeedback(msg("已进入归属预览，确认后保存到书架。"));}}>{msg("下一步 · 确认归属")}</button></div>
  </>:<>
   <div className="nc-catalog-review-heading"><div><h2>{msg("{0} 个条目待确认", {"0": chosen.length})}</h2><p>{msg("新增 {0} 项 · 已有 {1} 项保留原归属{2}", {"0": newCount, "1": chosen.length-newCount, "2": relatedCount?msg(" · {0} 项关联内容单独建立作品", {"0": relatedCount}):''})}</p></div><button className="button secondary" disabled={busy} onClick={()=>{setConfirm(false);setFeedback(msg("可继续调整选择，归属设置已保留。"));}}>{msg("调整选择")}</button></div>
   {needsDestination&&<div className="nc-catalog-destination"><span className="nc-catalog-destination-icon" aria-hidden="true">▤</span><div><span className="nc-eyebrow">{msg("新内容归入")}</span><h3>{destination}</h3><p>{msg("{0} · 各条目将自动识别为章节、番外或卷册", {"0": assignment.workId?msg("加入现有作品"):msg("在书架新建作品")})}</p></div><details className="nc-catalog-work-picker"><summary>{msg("更换作品")}</summary><div className="nc-catalog-work-options"><input type="search" aria-label={msg("搜索目标作品")} value={workQuery} onChange={e=>setWorkQuery(e.target.value)} placeholder={msg("搜索书架作品")}/><button className="nc-catalog-work-option" aria-pressed={!assignment.workId} disabled={busy} onClick={()=>setAssignment({...assignment,workId:undefined})}>{msg("＋ 新建作品")}</button>{library.works.filter(w=>!workQuery.trim()||w.title.toLocaleLowerCase().includes(workQuery.trim().toLocaleLowerCase())).map(work=><button className="nc-catalog-work-option" key={work.id} aria-pressed={assignment.workId===work.id} disabled={busy} onClick={()=>{setAssignment({...assignment,workId:work.id});setFeedback(msg("新内容将归入「{0}」。", {"0": work.title}));}}>{work.title}</button>)}{!assignment.workId&&<label className="field">{msg("新作品名称")}<input aria-label={msg("作品名称")} value={assignment.title} disabled={busy} onChange={e=>setAssignment({...assignment,title:e.target.value})} maxLength={180}/></label>}</div></details></div>}
   <div className="nc-catalog-grid nc-catalog-review-grid" aria-label={msg("条目归属预览")}>{chosen.slice(reviewPage*PAGE_SIZE,reviewPage*PAGE_SIZE+PAGE_SIZE).map(entry=><article className="nc-catalog-card nc-catalog-review-card" key={entry.id}><div className="nc-catalog-card-top"><span className="nc-catalog-kind">{kinds[overrides[entry.id]??suggestedKind(entry)]}</span><span className="nc-catalog-review-state">{already.has(entry.id)?msg("已有内容"):msg("新内容")}</span></div><h3>{entry.title}</h3><p>{already.has(entry.id)?msg("保留当前作品与内容版本"):entry.related?msg("单独建立「{0}」", {"0": entry.title}):destination}</p>{!entry.related&&!already.has(entry.id)&&<details className="nc-catalog-kind-picker"><summary>{msg("调整分类")}</summary><div role="group" aria-label={msg("{0}归属", {"0": entry.title})}>{Object.entries(kinds).map(([value,label])=><button key={value} disabled={busy} aria-pressed={(overrides[entry.id]??suggestedKind(entry))===value} onClick={()=>{setOverrides(previous=>({...previous,[entry.id]:value as ImportAssignment['kind']}));setFeedback(msg("「{0}」已设为{1}。", {"0": entry.title, "1": label}));}}>{label}</button>)}</div></details>}</article>)}</div>
   {pagination(chosen.length,reviewPage,setConfirmPage)}
   <div className="nc-catalog-save-options" role="group" aria-label={msg("原图保存方式")}><button aria-pressed={!offline} disabled={busy} onClick={()=>setOffline(false)}><b>{msg("按需读取")}</b><span>{msg("先加入书架，阅读时获取原图")}</span></button><button aria-pressed={offline} disabled={busy} onClick={()=>setOffline(true)}><b>{msg("离线保存")}</b><span>{msg("导入后加入统一采集队列")}</span></button></div>
   <p className="nc-catalog-save-note">{msg("{0} 导入不会发起翻译。", {"0": permissions.preparing?msg("正在提前读取图片域名…"):offline?msg("确认时先授权图片域名，再按目录顺序边发现边下载。"):msg("已获取的原图按缓存设置保留。")})}</p>
   {permissions.error&&<p role="alert">{permissions.error} <button className="text-link" onClick={permissions.retry}>{msg("重新检查图片域名")}</button></p>}
   <div className="nc-catalog-actionbar"><div className="nc-catalog-selection-summary"><strong>{msg("{0} 项 · {1}", {"0": chosen.length, "1": offline?msg("离线保存"):msg("按需读取")})}</strong><span>{msg("{0} 项新内容将加入书架", {"0": newCount})}</span></div><button className="button primary" disabled={busy||permissions.preparing||!!permissions.error||!chosen.length||!assignmentValid} onClick={()=>void submit()}>{busy?msg("正在保存到书架…"):msg("确认导入 {0} 项", {"0": chosen.length})}</button></div>
  </>}
  <p className="nc-catalog-feedback" role="status" aria-live="polite">{feedback||msg("已保留本次选择，可点击卡片或按住 Shift 选择连续范围。")}</p>
 </section>;
}
