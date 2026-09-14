import {useState} from 'react';
import type {ReadingCopy} from '../../types';
import type {ComicWork,ImportAssignment,LibraryState} from '../../library/types';
import {editLibrary} from '../../library/store';
import {attachCopy} from '../../library/model';
import {Modal} from '../components';
import {ImportAssignmentFields} from '../ImportAssignment';
import {relationLabels,type EditorKind,type LibraryRun,type UndoAssignment} from './shared';

const labels:Record<EditorKind,string>={work:'编辑作品',chapter:'编辑章节',publication:'编辑卷册',coverage:'纠正副本归属',inclusion:'关联收录章节',publicationRelations:'关联卷册',version:'新建内容版本',relation:'关联作品'};
export function LibraryEditor({kind,id,work,library:s,copies,run,busy,onClose,onUndo}:{kind:EditorKind;id?:string;work:ComicWork;library:LibraryState;copies:ReadingCopy[];run:LibraryRun;busy:boolean;onClose:()=>void;onUndo:(undo:UndoAssignment)=>void}){
 const chapter=s.chapters.find(c=>c.id===id),publication=s.publications.find(p=>p.id===id);
 const [title,setTitle]=useState(kind==='work'?work.title:kind==='chapter'?chapter?.title??'':kind==='publication'?publication?.title??'':'');
 const [number,setNumber]=useState(chapter?.number??publication?.number??'');
 const [value,setValue]=useState(kind==='work'?work.coverCopyId??'':kind==='chapter'?chapter?.role??'unknown':kind==='publication'?publication?.seriesId??'':'');
 const [extra,setExtra]=useState(kind==='publication'?publication?.isbn??'':'');
 const [checks,setChecks]=useState(new Set(kind==='inclusion'?s.inclusions.filter(i=>i.publicationId===id&&i.target.kind==='chapter').map(i=>i.target.id):kind==='publicationRelations'?s.publicationRelations.filter(r=>r.fromId===id).map(r=>r.kind+':'+r.toId):[]));
 const [assignment,setAssignment]=useState<ImportAssignment>({title:work.title,workId:work.id,kind:'unclassified'});
 const [error,setError]=useState('');
 const toggle=(key:string)=>setChecks(previous=>{const next=new Set(previous);next.has(key)?next.delete(key):next.add(key);return next;});
 async function save(){
  setError('');
  if(kind==='relation'&&!value){setError('请选择要关联的作品。');return;}
  let undo:UndoAssignment|undefined;
  const ok=await run('editor','正在保存',async()=>{try{await editLibrary((state,all)=>{
   const evidence={status:'user' as const,source:'用户管理'};
   const current=state.works.find(w=>w.id===work.id);if(!current)throw Error('作品已移除，请返回书架。');
   current.updatedAt=Date.now();
   if(kind==='work')Object.assign(current,{title:title.trim(),coverCopyId:value||undefined});
   if(kind==='chapter'){const item=state.chapters.find(c=>c.id===id);if(!item)throw Error('章节已移除。');Object.assign(item,{title:title.trim(),number:number||undefined,role:value});}
   if(kind==='publication'){const item=state.publications.find(p=>p.id===id);if(!item)throw Error('卷册已移除。');Object.assign(item,{title:title.trim(),number:number||undefined,seriesId:value||undefined,isbn:extra||undefined});}
   if(kind==='coverage'){
    const copy=all.find(c=>c.id===id);if(!copy)throw Error('副本已移除。');
    const before=state.coverage.filter(c=>c.copyId===copy.id);state.coverage=state.coverage.filter(c=>c.copyId!==copy.id);attachCopy(state,copy,assignment);
    undo={copyId:copy.id,before,afterIds:state.coverage.filter(c=>c.copyId===copy.id).map(c=>c.id)};
   }
   if(kind==='inclusion'){state.inclusions=state.inclusions.filter(i=>i.publicationId!==id||i.target.kind!=='chapter');[...checks].forEach((chapterId,order)=>state.inclusions.push({id:crypto.randomUUID(),publicationId:id!,target:{kind:'chapter',id:chapterId},order,evidence}));}
   if(kind==='publicationRelations'){state.publicationRelations=state.publicationRelations.filter(r=>r.fromId!==id);for(const key of checks){const [relationKind,toId]=key.split(':');state.publicationRelations.push({id:crypto.randomUUID(),fromId:id!,toId,kind:relationKind as 'collects'|'reprint',evidence});}}
   if(kind==='version'){const versionId=crypto.randomUUID();state.versions.push({id:versionId,workId:work.id,title:title.trim(),language:value||undefined,translator:extra||undefined,evidence});for(const copy of all)if(checks.has(copy.id))copy.versionId=versionId;}
   if(kind==='relation'){if(value===work.id)throw Error('请选择另一部作品。');if(state.relations.some(r=>r.fromId===work.id&&r.toId===value&&r.kind===(extra||'related')))throw Error('这条关联已经存在。');state.relations.push({id:crypto.randomUUID(),fromId:work.id,toId:value,kind:(extra||'related') as LibraryState['relations'][number]['kind'],evidence});}
  });}catch(reason){setError(reason instanceof Error?reason.message:'保存失败，请重试。');throw reason;}},`${labels[kind]}已保存`);
  if(ok){if(undo)onUndo(undo);onClose();}
 }
 const needsTitle=['work','chapter','publication','version'].includes(kind);
 return <Modal title={labels[kind]} onClose={()=>{if(!busy)onClose();}}>
  {error&&<p className="error-message" role="alert">{error}</p>}
  <div className="nc-editor-fields">
  {kind==='coverage'?<ImportAssignmentFields value={assignment} onChange={setAssignment} library={s}/>:kind==='inclusion'?<><p className="nc-muted">选择这册实际收录的章节。</p><div className="nc-choice-grid">{s.chapters.filter(c=>c.workId===work.id).map(c=><button className="nc-choice-card" aria-pressed={checks.has(c.id)} onClick={()=>toggle(c.id)} key={c.id}><span>{c.title}</span><b>{checks.has(c.id)?'已收录':'选择'}</b></button>)}</div></>:kind==='publicationRelations'?<>{(['collects','reprint'] as const).map(relationKind=><section key={relationKind} role="group" aria-label={relationKind==='collects'?'合订收录':'再版来源'}><h3>{relationKind==='collects'?'合订收录':'再版来源'}</h3><div className="nc-choice-grid">{s.publications.filter(p=>p.id!==id&&p.workIds.includes(work.id)).map(p=>{const key=relationKind+':'+p.id;return <button className="nc-choice-card" key={key} aria-pressed={checks.has(key)} onClick={()=>toggle(key)}><span>{p.title}</span><b>{checks.has(key)?'已关联':'选择'}</b></button>;})}</div></section>)}</>:kind==='relation'?<><label className="field">作品<select value={value} onChange={e=>setValue(e.target.value)}><option value="">选择一部作品</option>{s.works.filter(w=>w.id!==work.id).map(w=><option key={w.id} value={w.id}>{w.title}</option>)}</select></label><label className="field">关系<select value={extra||'related'} onChange={e=>setExtra(e.target.value)}>{Object.entries(relationLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></>:<>
   <label className="field">名称<input value={title} onChange={e=>setTitle(e.target.value)} maxLength={180}/></label>
   {['chapter','publication'].includes(kind)&&<label className="field">显示编号<input value={number} onChange={e=>setNumber(e.target.value)}/></label>}
   {kind==='chapter'&&<label className="field">内容性质<select value={value} onChange={e=>setValue(e.target.value)}><option value="unknown">未分类</option><option value="main">正文</option><option value="extra">番外</option></select></label>}
   {kind==='publication'&&<>{s.series.some(x=>x.workIds.includes(work.id))&&<label className="field">已有出版套系<select value={value} onChange={e=>setValue(e.target.value)}><option value="">未指定</option>{s.series.filter(x=>x.workIds.includes(work.id)).map(x=><option key={x.id} value={x.id}>{x.title}</option>)}</select></label>}<label className="field">ISBN（选填）<input value={extra} onChange={e=>setExtra(e.target.value)}/></label></>}
   {kind==='work'&&<label className="field">封面<select value={value} onChange={e=>setValue(e.target.value)}><option value="">自动选择</option>{copies.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label>}
   {kind==='version'&&<><div className="nc-form-grid"><label className="field">语言（选填）<input value={value} onChange={e=>setValue(e.target.value)}/></label><label className="field">译者／制作者（选填）<input value={extra} onChange={e=>setExtra(e.target.value)}/></label></div><p className="nc-muted">选择要归入此版本的副本，也可以稍后在副本详情中选择。</p><div className="nc-choice-grid">{copies.map(c=><button className="nc-choice-card" key={c.id} aria-pressed={checks.has(c.id)} onClick={()=>toggle(c.id)}><span>{c.title}</span><b>{checks.has(c.id)?'已选择':'选择'}</b></button>)}</div></>}
  </>}
  </div>
  <div className="nc-modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy||(needsTitle&&!title.trim())} onClick={()=>void save()}>{busy?'保存中…':'保存修改'}</button></div>
 </Modal>;
}
