import {useEffect,useMemo,useRef,useState} from 'react';
import type {ImportAssignment,LibraryState,SourceCatalog,SourceEntry} from '../library/types';
import type {ReadingCopy} from '../types';
import {makeCopy,selectRange,suggestedKind} from '../library/model';
import {commitCopies} from '../library/store';
import {queueCopies} from '../library/acquisition';
import './catalog.css';

const PAGE_SIZE=40;
const kinds:Record<ImportAssignment['kind'],string>={chapter:'章节',extra:'番外',publication:'卷册',unclassified:'待整理',work:'独立作品'};
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
 const visibleIds=new Set(filtered.map(e=>e.id)),hiddenSelected=chosen.filter(e=>!visibleIds.has(e.id)).length;
 const added=catalog.entries.filter(e=>!previous?.entries.some(p=>p.id===e.id)).length;
 const changed=catalog.entries.filter(e=>previous?.entries.some(p=>p.id===e.id&&(p.title!==e.title||p.rawTypes.join()!==e.rawTypes.join()))).length;
 const newCount=chosen.filter(e=>!already.has(e.id)).length,relatedCount=chosen.filter(e=>e.related&&!already.has(e.id)).length;
 const destination=assignment.workId?library.works.find(w=>w.id===assignment.workId)?.title??'作品已移除':assignment.title.trim()||'未命名作品';
 const needsDestination=chosen.some(e=>!e.related&&!already.has(e.id));
 const assignmentValid=!needsDestination||!!(assignment.workId?library.works.some(w=>w.id===assignment.workId):assignment.title.trim());
 const activePage=Math.min(page,Math.max(0,Math.ceil(filtered.length/PAGE_SIZE)-1));
 const reviewPage=Math.min(confirmPage,Math.max(0,Math.ceil(chosen.length/PAGE_SIZE)-1));
 const rangeLabel=rangeStart?catalog.entries.find(e=>e.id===rangeStart)?.title:undefined;
 function filterChanged(change:()=>void){change();setPage(0);setRangeStart(undefined);lastClicked.current=undefined;setFeedback('已更新显示范围，原有选择已保留。');}
 function select(ids:string[],add=true){setSelected(prev=>{const next=new Set(prev);for(const id of ids)add?next.add(id):next.delete(id);return next;});}
 function toggleEntry(entry:SourceEntry,shiftKey:boolean){
  if(rangeMode){
   if(!rangeStart){setRangeStart(entry.id);setFeedback('已标记起点「'+entry.title+'」，请选择终点，可翻页。');return;}
   const ids=selectRange(filtered,rangeStart,entry.id);select(ids);setRangeStart(undefined);setRangeMode(false);setFeedback('已选中连续 '+ids.length+' 项。');
  }else if(shiftKey&&lastClicked.current&&visibleIds.has(lastClicked.current)){
   const ids=selectRange(filtered,lastClicked.current,entry.id);select(ids);setFeedback('已选中连续 '+ids.length+' 项。');
  }else{select([entry.id],!selected.has(entry.id));setFeedback((selected.has(entry.id)?'已取消「':'已选择「')+entry.title+'」。');}
  lastClicked.current=entry.id;
 }
 async function refresh(){if(refreshing)return;setRefreshing(true);setError('');setFeedback('正在读取最新来源目录…');try{await onRefresh();setFeedback('已完成目录刷新。');}catch(e){setError(e instanceof Error?e.message:'目录刷新失败，请重试。');}finally{setRefreshing(false);}}
 async function submit(){
  if(saving.current||!chosen.length||!assignmentValid)return;
  saving.current=true;setBusy(true);setError('');setFeedback('正在保存 '+chosen.length+' 个来源条目…');
  try{
   const incoming=chosen.map(entry=>({...makeCopy(entry.title,[],'MangaCopy',entry.id),sourceEntryId:entry.id,sourceUrl:entry.url,retention:offline?'offline' as const:'cache' as const,discoveryComplete:false}));
   const mappings=chosen.map(entry=>entry.related?{title:entry.title,kind:'unclassified' as const}:{...assignment,kind:overrides[entry.id]??suggestedKind(entry)});
   const result=await commitCopies(incoming,mappings,catalog);
   let message='已导入 '+result.created+' 个新条目'+(chosen.length>result.created?'，保留 '+(chosen.length-result.created)+' 个已有条目':'')+'。';
   if(offline){
    try{await queueCopies(result.copyIds);message+=' 原图将离线保留，待获取内容可在采集中心查看。';}
    catch(e){message+=' 原图未加入队列：'+(e instanceof Error?e.message:'请在采集中心重试。');}
   }
   try{localStorage.removeItem('nc-catalog-selection:'+catalog.id);}catch{}
   onDone();onClose();onNotice?.(message);
  }catch(e){setError(e instanceof Error?e.message:'保存失败，请重试。');setFeedback('导入未完成，选择与归属已保留。');}
  finally{saving.current=false;setBusy(false);}
 }
 function pagination(total:number,current:number,setCurrent:(page:number)=>void){return <nav className="nc-pagination" aria-label={confirm?'归属预览分页':'来源目录分页'}><span>{total} 项 · 第 {current+1} / {Math.max(1,Math.ceil(total/PAGE_SIZE))} 页</span><button className="button secondary" disabled={current===0||busy} onClick={()=>setCurrent(current-1)}>上一页</button><button className="button secondary" disabled={(current+1)*PAGE_SIZE>=total||busy} onClick={()=>setCurrent(current+1)}>下一页</button></nav>;}
 return <section className="nc-catalog-import" aria-busy={busy||refreshing}>
  <div className="nc-page-heading"><div><span className="nc-eyebrow">{previous?'更新来源目录':'导入来源目录'} · {confirm?'02 确认导入':'01 选择内容'}</span><h1>{catalog.title}</h1><p>{confirm?'确认作品归属和保存方式，即可加入书架。':'点击卡片选择要加入书架的内容，也可以跨页批量选择。'}</p></div><button className="button secondary" disabled={busy} onClick={onClose}>返回书架</button></div>
  <div className="nc-catalog-overview"><div><b>{catalog.entries.length}</b><span>已发现条目</span></div><div><b>{catalog.entries.filter(e=>already.has(e.id)).length}</b><span>已在书架</span></div><div><b>{catalog.groups.length}</b><span>来源分组</span></div><span className={'nc-catalog-completeness'+(!catalog.complete?' is-partial':'')}>{catalog.complete?'目录已读取完整':'目录仍有待发现内容'}</span>{!confirm&&<button className="text-link" disabled={refreshing} onClick={()=>void refresh()}>{refreshing?'正在更新…':'刷新目录'}</button>}</div>
  {!catalog.complete&&<div className="notice warning">当前只显示已发现条目，可以先导入这些内容，再刷新目录补齐。</div>}
  {previous&&<details className="nc-catalog-difference"><summary>目录变化：新增 {added} 项 · 标签更新 {changed} 项</summary><p>{catalog.note} {catalog.complete?'未出现的旧条目继续保留。':'当前目录不完整，不据此移除旧条目。'} 已移除的条目需要手动选择后才会恢复。</p>{changed>0&&<div className="nc-catalog-change-grid">{catalog.entries.filter(e=>previous.entries.some(p=>p.id===e.id&&(p.title!==e.title||p.rawTypes.join()!==e.rawTypes.join()))).slice(0,12).map(e=><span key={e.id}>{previous.entries.find(p=>p.id===e.id)?.title} → {e.title}<small>{e.rawTypes.join(' / ')||'未分类'}</small></span>)}{changed>12&&<span>另有 {changed-12} 项标签更新</span>}</div>}</details>}
  {error&&<p role="alert" className="error-message">{error}</p>}
  {!confirm?<>
   <div className="nc-catalog-group-tabs" role="group" aria-label="来源分组"><button aria-pressed={!group} onClick={()=>filterChanged(()=>setGroup(''))}>全部分组 <span>{catalog.entries.length}</span></button>{catalog.groups.map(g=><button key={g.id} aria-pressed={group===g.id} onClick={()=>filterChanged(()=>setGroup(g.id))}>{g.title} <span>{g.entryIds.length}</span></button>)}</div>
   <div className="nc-catalog-toolbar"><input className="nc-catalog-search" type="search" aria-label="搜索来源条目" placeholder="搜索章节、番外或卷册…" value={query} onChange={e=>filterChanged(()=>setQuery(e.target.value))}/><select aria-label="导入状态筛选" value={status} onChange={e=>filterChanged(()=>setStatus(e.target.value))}><option value="all">全部状态</option><option value="new">未导入</option><option value="imported">已在书架</option><option value="removed">已移除</option></select><select aria-label="原站类型" value={type} onChange={e=>filterChanged(()=>setType(e.target.value))}><option value="">全部类型</option>{[...new Set(catalog.entries.flatMap(e=>e.rawTypes))].map(t=><option key={t}>{t}</option>)}</select><select aria-label="来源条目排序" value={sort} onChange={e=>filterChanged(()=>setSort(e.target.value))}><option value="source">来源顺序 · 正序</option><option value="reverse">来源顺序 · 倒序</option><option value="title">标题 · 自然排序</option></select></div>
   <div className="nc-catalog-results"><span>当前显示 {filtered.length} 项</span><span>{hiddenSelected>0?'有 '+hiddenSelected+' 个已选条目在其他筛选中':'切换筛选与排序会保留已选内容'}</span></div>
   {rangeMode&&<div className="notice nc-catalog-range-hint">{rangeStart?'起点：'+rangeLabel+'。点击终点完成连续选择，可跨页。':'点击范围起点，再点击终点，按当前排序连续选择。'}<button className="text-link" onClick={()=>{setRangeMode(false);setRangeStart(undefined);setFeedback('已取消范围选择。');}}>取消范围选择</button></div>}
   {filtered.length?<div className="nc-catalog-grid" aria-label="来源条目卡片">{filtered.slice(activePage*PAGE_SIZE,activePage*PAGE_SIZE+PAGE_SIZE).map(entry=><button className={'nc-catalog-card'+(selected.has(entry.id)?' is-selected':'')+(rangeStart===entry.id?' is-range-start':'')} key={entry.id} aria-pressed={selected.has(entry.id)} aria-label={entry.title+'，'+(already.has(entry.id)?'已在书架':excluded.has(entry.id)?'已移除':'未导入')} onClick={event=>toggleEntry(entry,event.shiftKey)}><div className="nc-catalog-card-top"><span className="nc-catalog-kind">{kinds[suggestedKind(entry)]}</span><span className="nc-catalog-check" aria-hidden="true">{selected.has(entry.id)?'✓':'+'}</span></div><h3>{entry.title}</h3><p>{entry.groupIds.map(id=>catalog.groups.find(g=>g.id===id)?.title).filter(Boolean).join(' / ')||'未分组'}</p><div className="nc-catalog-card-foot"><span className={already.has(entry.id)?'is-imported':excluded.has(entry.id)?'is-removed':''}>{already.has(entry.id)?'已在书架':excluded.has(entry.id)?'已移除 · 可恢复':'未导入'}</span>{entry.related&&<span>独立归属</span>}</div></button>)}</div>:<div className="nc-catalog-empty"><b>没有符合条件的条目</b><p>调整搜索或筛选，已选内容仍然保留。</p><button className="button secondary" onClick={()=>filterChanged(()=>{setQuery('');setStatus('all');setType('');setGroup('');})}>清除筛选</button></div>}
   {pagination(filtered.length,activePage,setPage)}
   <div className="nc-catalog-actionbar"><div className="nc-catalog-selection-summary"><strong>已选 {chosen.length} 项</strong><span>{newCount} 项新内容{hiddenSelected?' · 含其他筛选中 '+hiddenSelected+' 项':''}</span></div><div className="nc-catalog-batch-actions"><button className="text-link" disabled={!filtered.length||filtered.every(e=>selected.has(e.id))} onClick={()=>{select(filtered.map(e=>e.id));setFeedback('已选中当前筛选的全部 '+filtered.length+' 项，包含其他分页。');}}>全选当前结果（跨页）</button><button className="text-link" disabled={!filtered.length} aria-pressed={rangeMode} onClick={()=>{setRangeMode(!rangeMode);setRangeStart(undefined);setFeedback(rangeMode?'已退出范围选择。':'请选择范围起点和终点。');}}>连续范围</button><button className="text-link" disabled={!selected.size} onClick={()=>{setSelected(new Set());setFeedback('已清空全部选择。');}}>清空</button></div><button className="button primary" disabled={!chosen.length} onClick={()=>{setConfirm(true);setConfirmPage(0);setFeedback('已进入归属预览，确认后保存到书架。');}}>下一步 · 确认归属</button></div>
  </>:<>
   <div className="nc-catalog-review-heading"><div><h2>{chosen.length} 个条目待确认</h2><p>新增 {newCount} 项 · 已有 {chosen.length-newCount} 项保留原归属{relatedCount?' · '+relatedCount+' 项关联内容单独建立作品':''}</p></div><button className="button secondary" disabled={busy} onClick={()=>{setConfirm(false);setFeedback('可继续调整选择，归属设置已保留。');}}>调整选择</button></div>
   {needsDestination&&<div className="nc-catalog-destination"><span className="nc-catalog-destination-icon" aria-hidden="true">▤</span><div><span className="nc-eyebrow">新内容归入</span><h3>{destination}</h3><p>{assignment.workId?'加入现有作品':'在书架新建作品'} · 各条目将自动识别为章节、番外或卷册</p></div><details className="nc-catalog-work-picker"><summary>更换作品</summary><div className="nc-catalog-work-options"><input type="search" aria-label="搜索目标作品" value={workQuery} onChange={e=>setWorkQuery(e.target.value)} placeholder="搜索书架作品"/><button className="nc-catalog-work-option" aria-pressed={!assignment.workId} disabled={busy} onClick={()=>setAssignment({...assignment,workId:undefined})}>＋ 新建作品</button>{library.works.filter(w=>!workQuery.trim()||w.title.toLocaleLowerCase().includes(workQuery.trim().toLocaleLowerCase())).map(work=><button className="nc-catalog-work-option" key={work.id} aria-pressed={assignment.workId===work.id} disabled={busy} onClick={()=>{setAssignment({...assignment,workId:work.id});setFeedback('新内容将归入「'+work.title+'」。');}}>{work.title}</button>)}{!assignment.workId&&<label className="field">新作品名称<input aria-label="作品名称" value={assignment.title} disabled={busy} onChange={e=>setAssignment({...assignment,title:e.target.value})} maxLength={180}/></label>}</div></details></div>}
   <div className="nc-catalog-grid nc-catalog-review-grid" aria-label="条目归属预览">{chosen.slice(reviewPage*PAGE_SIZE,reviewPage*PAGE_SIZE+PAGE_SIZE).map(entry=><article className="nc-catalog-card nc-catalog-review-card" key={entry.id}><div className="nc-catalog-card-top"><span className="nc-catalog-kind">{kinds[overrides[entry.id]??suggestedKind(entry)]}</span><span className="nc-catalog-review-state">{already.has(entry.id)?'已有内容':'新内容'}</span></div><h3>{entry.title}</h3><p>{already.has(entry.id)?'保留当前作品与内容版本':entry.related?'单独建立「'+entry.title+'」':destination}</p>{!entry.related&&!already.has(entry.id)&&<details className="nc-catalog-kind-picker"><summary>调整分类</summary><div role="group" aria-label={entry.title+'归属'}>{Object.entries(kinds).map(([value,label])=><button key={value} disabled={busy} aria-pressed={(overrides[entry.id]??suggestedKind(entry))===value} onClick={()=>{setOverrides(previous=>({...previous,[entry.id]:value as ImportAssignment['kind']}));setFeedback('「'+entry.title+'」已设为'+label+'。');}}>{label}</button>)}</div></details>}</article>)}</div>
   {pagination(chosen.length,reviewPage,setConfirmPage)}
   <div className="nc-catalog-save-options" role="group" aria-label="原图保存方式"><button aria-pressed={!offline} disabled={busy} onClick={()=>setOffline(false)}><b>按需读取</b><span>先加入书架，阅读时获取原图</span></button><button aria-pressed={offline} disabled={busy} onClick={()=>setOffline(true)}><b>离线保存</b><span>导入后加入统一采集队列</span></button></div>
   <p className="nc-catalog-save-note">{offline?'保持插件页面打开以下载原图，关闭后可在采集中心恢复。':'已获取的原图按缓存设置保留。'} 导入不会发起翻译。</p>
   <div className="nc-catalog-actionbar"><div className="nc-catalog-selection-summary"><strong>{chosen.length} 项 · {offline?'离线保存':'按需读取'}</strong><span>{newCount} 项新内容将加入书架</span></div><button className="button primary" disabled={busy||!chosen.length||!assignmentValid} onClick={()=>void submit()}>{busy?'正在保存到书架…':'确认导入 '+chosen.length+' 项'}</button></div>
  </>}
  <p className="nc-catalog-feedback" role="status" aria-live="polite">{feedback||'已保留本次选择，可点击卡片或按住 Shift 选择连续范围。'}</p>
 </section>;
}
