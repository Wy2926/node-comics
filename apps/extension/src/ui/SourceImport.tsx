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
 return <Modal title="加入漫画" subtitle={`${manifest.title} · 已选 ${selected.length} 张`} onClose={()=>{if(!busy)onClose();}}>
  {error&&<p role="alert" className="error-message">{error}</p>}
  <fieldset className="nc-web-import" disabled={busy}>
   <details open={manifest.selectionConfirmed?undefined:true}><summary>查看图片与阅读顺序 · {selected.length} 张</summary><SourceImagePicker choices={choices} onChange={setChoices} generic={manifest.adapter==='generic'} disabled={busy}/></details>
   <div className="segmented" role="group" aria-label="加入方式"><button type="button" className={mode==='new'?'active':''} aria-pressed={mode==='new'} onClick={()=>setMode('new')}>新增阅读副本</button><button type="button" className={mode==='insert'?'active':''} aria-pressed={mode==='insert'} onClick={()=>{setMode('insert');if(!assignment.workId&&library.works[0])changeAssignment({...assignment,workId:library.works[0].id});}}>插入已有副本</button></div>
   {mode==='new'?<>
    <ImportAssignmentFields value={assignment} onChange={changeAssignment} library={library}/>
    <label className="field">副本／新条目名称<input aria-label="副本／新条目名称" value={title} onChange={e=>setTitle(e.target.value)} maxLength={180}/></label>
    <p className="nc-insert-summary">{work?`加入《${work.title}》，按所选章节或卷册归档。`:'新建作品后，按所选内容归属整理。'}关联已有条目会保留为另一份阅读副本。</p>
   </>:<>
    <label className="field">目标作品<select aria-label="目标作品" value={assignment.workId??''} onChange={e=>changeAssignment({...assignment,workId:e.target.value})}><option value="" disabled>选择已有作品</option>{library.works.map(work=><option value={work.id} key={work.id}>{work.title}</option>)}</select></label>
    <label className="field">目标副本<select aria-label="目标副本" value={target?.id??''} onChange={e=>{setCopyId(e.target.value);setPosition({kind:'end'});}}><option value="" disabled>选择阅读副本</option>{targets.map(copy=><option key={copy.id} value={copy.id}>{copy.title} · {copy.pages.length} 页 · {copy.source}</option>)}</select></label>
    {target&&<div className="nc-form-grid"><label className="field">插入位置<select aria-label="插入位置" value={position.kind} onChange={e=>setPosition(e.target.value==='after'?{kind:'after',pageId:target.pages[0]?.id??''}:{kind:e.target.value as 'start'|'end'})}><option value="end">追加到末尾</option><option value="start">插入到开头</option><option value="after" disabled={!target.pages.length}>指定页面之后</option></select></label>{position.kind==='after'&&<label className="field">接在哪一页后<select aria-label="接在哪一页后" value={position.pageId} onChange={e=>setPosition({kind:'after',pageId:e.target.value})}>{target.pages.map((page,index)=><option key={page.id} value={page.id}>第 {index+1} 页 · {page.name}</option>)}</select></label>}</div>}
    {blocked?<p role="alert" className="error-message">{blocked}</p>:<p className="nc-insert-summary">{target?`向《${target.title}》插入 ${selected.length} 张，插入后共 ${target.pages.length+selected.length} 页。原有页面、译图和阅读位置保留。`:'还没有可插入的副本，请先新增一份阅读副本。'}</p>}
   </>}
   <p className="nc-muted">{manifest.note} 原图将保存到当前设备，翻译在阅读器中按需开始。</p>
   <button type="button" className="button primary full" disabled={!valid||busy} onClick={submit}>{busy?'正在获取原图…':mode==='insert'?'插入图片并继续阅读':'获取原图并加入漫画'}</button>
  </fieldset>
 </Modal>;
}
