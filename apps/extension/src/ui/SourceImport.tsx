import {msg} from '../i18n/runtime';
import {useEffect,useRef,useState} from 'react';
import type {ReadingCopy} from '../types';
import type {ImportAssignment,LibraryState} from '../library/types';
import type {PageManifest} from '../sources/adapters';
import {sourcePageIdentity} from '../sources/mangacopy';
import {initialChoices,selectManifest} from '../sources/selection';
import {insertionBlocked,type InsertPosition,type WebDestination} from '../library/web-import';
import {Modal} from './components';
import {ImportAssignmentFields} from './ImportAssignment';
import {SourceImagePicker} from './SourceImagePicker';

export function SourceImport({manifest,library,copies,busy,error,onClose,onImport}:{manifest:PageManifest;library:LibraryState;copies:ReadingCopy[];busy:boolean;error:string;onClose:()=>void;onImport:(manifest:PageManifest,destination:WebDestination)=>Promise<void>}){
 const [choices,setChoices]=useState(()=>initialChoices(manifest));
 const [mode,setMode]=useState<'new'|'insert'>('new'),[title,setTitle]=useState(manifest.title);
 const [assignment,setAssignment]=useState<ImportAssignment>({title:manifest.title,kind:'unclassified'});
 const [copyId,setCopyId]=useState(''),[position,setPosition]=useState<InsertPosition>({kind:'end'});
 const touched=useRef(false);
 useEffect(()=>{
  if(touched.current||!library.works.length)return;
  const sameSource=copies.find(copy=>copy.sourceUrl&&sourcePageIdentity(copy.sourceUrl)===sourcePageIdentity(manifest.url));
  const knownWork=library.coverage.find(item=>item.copyId===sameSource?.id)?.workId??localStorage.getItem('nc-web-import-work');
  if(knownWork&&library.works.some(work=>work.id===knownWork))setAssignment(value=>({...value,workId:knownWork}));
 },[library.works,library.coverage,copies,manifest.url]);
 const selected=choices.filter(item=>item.selected),work=library.works.find(work=>work.id===assignment.workId);
 const targets=copies.filter(copy=>library.coverage.some(item=>item.copyId===copy.id&&item.workId===work?.id));
 const target=targets.find(copy=>copy.id===copyId)??targets[0];
 const blocked=target?insertionBlocked(target,library):undefined;
 const valid=selected.length>0&&(mode==='new'?(!!work||!!assignment.title.trim())&&!!title.trim():!!target&&!blocked&&(position.kind!=='after'||target.pages.some(page=>page.id===position.pageId)));
 function changeAssignment(value:ImportAssignment){touched.current=true;setAssignment(value);setCopyId('');setPosition({kind:'end'});}
 function submit(){
  if(!valid||busy)return;
  const destination:WebDestination=mode==='new'?{mode,assignment,title:title.trim()}:{mode,copyId:target!.id,revision:target!.manifestRevision,position};
  void onImport(selectManifest(manifest,selected.map(item=>item.id)),destination);
 }
 return <Modal title={msg("加入漫画")} subtitle={msg("{0} · 已选 {1} 张", {"0": manifest.title, "1": selected.length})} onClose={()=>{if(!busy)onClose();}}>
  {error&&<p role="alert" className="error-message">{error}</p>}
  <fieldset className="nc-web-import" disabled={busy}>
   <details open={manifest.selectionConfirmed?undefined:true}><summary>{msg("查看图片与阅读顺序 · {0} 张", {"0": selected.length})}</summary><SourceImagePicker choices={choices} onChange={setChoices} disabled={busy}/></details>
   <div className="segmented" role="group" aria-label={msg("加入方式")}><button type="button" className={mode==='new'?'active':''} aria-pressed={mode==='new'} onClick={()=>setMode('new')}>{msg("新增阅读副本")}</button><button type="button" className={mode==='insert'?'active':''} aria-pressed={mode==='insert'} onClick={()=>{setMode('insert');if(!assignment.workId&&library.works[0])changeAssignment({...assignment,workId:library.works[0].id});}}>{msg("插入已有副本")}</button></div>
   {mode==='new'?<>
    <ImportAssignmentFields value={assignment} onChange={changeAssignment} library={library}/>
    <label className="field">{msg("副本／新条目名称")}<input aria-label={msg("副本／新条目名称")} value={title} onChange={e=>setTitle(e.target.value)} maxLength={180}/></label>
    <p className="nc-insert-summary">{msg("{0}关联已有条目会保留为另一份阅读副本。", {"0": work?msg("加入《{0}》，按所选章节或卷册归档。", {"0": work.title}):msg("新建作品后，按所选内容归属整理。")})}</p>
   </>:<>
    <label className="field">{msg("目标作品")}<select aria-label={msg("目标作品")} value={assignment.workId??''} onChange={e=>changeAssignment({...assignment,workId:e.target.value})}><option value="" disabled>{msg("选择已有作品")}</option>{library.works.map(work=><option value={work.id} key={work.id}>{work.title}</option>)}</select></label>
    <label className="field">{msg("目标副本")}<select aria-label={msg("目标副本")} value={target?.id??''} onChange={e=>{setCopyId(e.target.value);setPosition({kind:'end'});}}><option value="" disabled>{msg("选择阅读副本")}</option>{targets.map(copy=><option key={copy.id} value={copy.id}>{msg("{0} · {1} 页 · {2}", {"0": copy.title, "1": copy.pages.length, "2": copy.source})}</option>)}</select></label>
    {target&&<div className="nc-form-grid"><label className="field">{msg("插入位置")}<select aria-label={msg("插入位置")} value={position.kind} onChange={e=>setPosition(e.target.value==='after'?{kind:'after',pageId:target.pages[0]?.id??''}:{kind:e.target.value as 'start'|'end'})}><option value="end">{msg("追加到末尾")}</option><option value="start">{msg("插入到开头")}</option><option value="after" disabled={!target.pages.length}>{msg("指定页面之后")}</option></select></label>{position.kind==='after'&&<label className="field">{msg("接在哪一页后")}<select aria-label={msg("接在哪一页后")} value={position.pageId} onChange={e=>setPosition({kind:'after',pageId:e.target.value})}>{target.pages.map((page,index)=><option key={page.id} value={page.id}>{msg("第 {0} 页 · {1}", {"0": index+1, "1": page.name})}</option>)}</select></label>}</div>}
    {blocked?<p role="alert" className="error-message">{blocked}</p>:<p className="nc-insert-summary">{target?msg("向《{0}》插入 {1} 张，插入后共 {2} 页。原有页面、译图和阅读位置保留。", {"0": target.title, "1": selected.length, "2": target.pages.length+selected.length}):msg("还没有可插入的副本，请先新增一份阅读副本。")}</p>}
   </>}
   <p className="nc-muted">{msg("{0} 原图将保存到当前设备，翻译在阅读器中按需开始。", {"0": manifest.note})}</p>
   <button type="button" className="button primary full" disabled={!valid||busy} onClick={submit}>{busy?msg("正在获取原图…"):mode==='insert'?msg("插入图片并继续阅读"):msg("获取原图并加入漫画")}</button>
  </fieldset>
 </Modal>;
}
