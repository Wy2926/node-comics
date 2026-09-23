import {useEffect,useId,useRef,useState} from 'react';
import {Select} from './Select';
import {msg} from '../i18n/runtime';
import {getReadingUnit,getWork,searchWorks,searchWorkUnits,type ReadingUnit,type Work} from '../comics/application/library-service';
import type {ImportAssignment,LibraryViewModel} from '../comics/application/types';
import './import-assignment.css';

const PAGE_SIZE=20;
const kindLabel=(kind:ImportAssignment['kind'])=>kind==='chapter'?msg('话／章节'):kind==='volume'?msg('卷册'):kind==='book'?msg('单行本'):msg('未分类');
const roleLabel=(role:ImportAssignment['role'])=>role==='main'?msg('正文'):role==='extra'?msg('番外'):msg('未分类');
interface WorkPage {key:string;works:Work[];nextOffset?:number;error?:string}
interface UnitPage {key:string;units:ReadingUnit[];nextOffset?:number;error?:string}
function Pages({offset,nextOffset,onChange}:{offset:number;nextOffset?:number;onChange:(offset:number)=>void}){
 return <nav className="nc-assignment-pages"><button type="button" className="text-link" disabled={!offset} onClick={()=>onChange(Math.max(0,offset-PAGE_SIZE))}>{msg('上一页')}</button><span>{Math.floor(offset/PAGE_SIZE)+1}</span><button type="button" className="text-link" disabled={nextOffset===undefined} onClick={()=>onChange(nextOffset!)}>{msg('下一页')}</button></nav>;
}

/** A draft destination only: records are created by the eventual import command. */
export function ImportAssignmentFields({value,onChange,library,workOnly=false}:{value:ImportAssignment;onChange:(v:ImportAssignment)=>void;library:LibraryViewModel;workOnly?:boolean}){
 const id=useId(),newTitle=useRef(value.workId?'':value.title);
 const [workMode,setWorkMode]=useState<'new'|'existing'>(value.workId?'existing':'new');
 const [workPicker,setWorkPicker]=useState(false),[workQuery,setWorkQuery]=useState(''),[workOffset,setWorkOffset]=useState(0),[workPage,setWorkPage]=useState<WorkPage>();
 const [unitPicker,setUnitPicker]=useState(false),[unitQuery,setUnitQuery]=useState(''),[unitOffset,setUnitOffset]=useState(0),[unitPage,setUnitPage]=useState<UnitPage>();
 const [work,setWork]=useState<Work>(),[unit,setUnit]=useState<ReadingUnit>(),[workError,setWorkError]=useState(''),[unitError,setUnitError]=useState('');
 const mode=value.workId?'existing':workMode;
 const selectedWork=work?.id===value.workId?work:library.works.find(item=>item.id===value.workId);
 const selectedUnit=unit&&unit.id===value.unitId&&unit.workId===value.workId?unit:library.units.find(item=>item.id===value.unitId&&item.workId===value.workId);
 const workKey=JSON.stringify([workQuery.trim(),workOffset]),unitKey=JSON.stringify([value.workId,unitQuery.trim(),unitOffset]);
 const visibleWorks=workPage?.key===workKey?workPage:undefined,visibleUnits=unitPage?.key===unitKey?unitPage:undefined;

 useEffect(()=>{
  let active=true;setWorkError('');setWork(previous=>previous?.id===value.workId?previous:undefined);
  if(!value.workId)return;
  setWorkMode('existing');
  void getWork(value.workId).then(item=>{if(active){setWork(item);if(!item)setWorkError(msg('作品已移除。'));}}).catch(error=>{if(active)setWorkError((error as Error).message);});
  return()=>{active=false;};
 },[value.workId]);
 useEffect(()=>{
  let active=true;setUnitError('');setUnit(previous=>previous?.id===value.unitId?previous:undefined);
  if(!value.unitId)return;
  void getReadingUnit(value.unitId).then(item=>{if(active){if(item?.workId===value.workId)setUnit(item);else setUnitError(msg('没有匹配的内容'));}}).catch(error=>{if(active)setUnitError((error as Error).message);});
  return()=>{active=false;};
 },[value.workId,value.unitId]);
 useEffect(()=>{
  if(!workPicker)return;
  let active=true;
  const timer=setTimeout(()=>void searchWorks(workQuery.trim(),workOffset,PAGE_SIZE).then(page=>{if(active)setWorkPage({key:workKey,...page});}).catch(error=>{if(active)setWorkPage({key:workKey,works:[],error:(error as Error).message});}),120);
  return()=>{active=false;clearTimeout(timer);};
 },[workPicker,workKey]);
 useEffect(()=>{
  if(!unitPicker||!value.workId||workOnly)return;
  let active=true;
  const timer=setTimeout(()=>void searchWorkUnits(value.workId!,unitQuery.trim(),unitOffset,PAGE_SIZE).then(page=>{if(active)setUnitPage({key:unitKey,...page});}).catch(error=>{if(active)setUnitPage({key:unitKey,units:[],error:(error as Error).message});}),120);
  return()=>{active=false;clearTimeout(timer);};
 },[unitPicker,unitKey,workOnly]);

 function chooseNewWork(){
  if(mode==='new')return;
  setWorkMode('new');setWorkPicker(false);setUnitPicker(false);
  onChange({...value,workId:undefined,unitId:undefined,title:newTitle.current});
 }
 function chooseExistingWork(){
  if(!value.workId&&mode!=='existing'){newTitle.current=value.title;onChange({...value,title:'',unitId:undefined});}
  setWorkMode('existing');setWorkPicker(true);setWorkOffset(0);
 }
 function selectWork(item:Work){
  setWork(item);setWorkPicker(false);setUnitPicker(false);setUnitQuery('');setUnitOffset(0);
  onChange({...value,workId:item.id,title:item.title,unitId:undefined});
 }
 function selectUnit(item:ReadingUnit){
  setUnit(item);setUnitPicker(false);
  onChange({...value,unitId:item.id,kind:item.kind,role:item.role});
 }
 return <div className="nc-assignment">
  <section className="nc-assignment-section" aria-labelledby={`${id}-work`}>
   <div className="nc-assignment-heading"><h4 id={`${id}-work`}>{msg('归入作品')}</h4><div className="nc-assignment-modes"><button type="button" aria-pressed={mode==='new'} onClick={chooseNewWork}>{msg('新建作品')}</button><button type="button" aria-pressed={mode==='existing'} onClick={chooseExistingWork}>{msg('加入已有作品')}</button></div></div>
   {mode==='new'?<>
    <label className="field" htmlFor={`${id}-title`}>{msg('作品名称')}<input id={`${id}-title`} required aria-invalid={!value.title.trim()} aria-describedby={`${id}-preview`} value={value.title} maxLength={180} onChange={event=>{newTitle.current=event.target.value;onChange({...value,title:event.target.value});}}/></label>
    <div id={`${id}-preview`} className="nc-assignment-preview" aria-live="polite"><strong>{value.title.trim()?msg('导入后将新建「{0}」',{'0':value.title.trim()}):msg('作品名称不能为空。')}</strong><span>{msg('导入时创建作品，现在不会产生空作品。')}</span></div>
   </>:<>
    {value.workId&&<div className="nc-assignment-selected"><div><span>{msg('已选择')}</span><strong>{selectedWork?.title??msg('正在读取作品…')}</strong>{selectedWork?.aliases?.length?<small>{selectedWork.aliases.join(' · ')}</small>:null}</div><button type="button" className="text-link" onClick={()=>setWorkPicker(!workPicker)} aria-expanded={workPicker}>{msg('更换作品')}</button></div>}
    {workError&&<p role="alert" className="error-message">{workError}</p>}
    {workPicker&&<div className="nc-assignment-picker" aria-label={msg('选择已有作品')}>
     <label className="field">{msg('搜索书架作品')}<input type="search" value={workQuery} onChange={event=>{setWorkQuery(event.target.value);setWorkOffset(0);}} placeholder={msg('搜索作品名称')}/></label>
     {!visibleWorks?<p role="status" className="nc-muted">{msg('正在读取作品…')}</p>:visibleWorks.error?<p role="alert" className="error-message">{visibleWorks.error}</p>:<>
      <div className="nc-assignment-results">{visibleWorks.works.map(item=><button type="button" key={item.id} aria-pressed={value.workId===item.id} onClick={()=>selectWork(item)}><span><strong>{item.title}</strong>{item.aliases?.length?<small>{item.aliases.join(' · ')}</small>:null}</span><b>{value.workId===item.id?msg('已选择'):msg('选择此作品')}</b></button>)}</div>
      {!visibleWorks.works.length&&<p className="nc-muted">{msg('没有找到作品，请尝试其他关键词。')}</p>}
      <Pages offset={workOffset} nextOffset={visibleWorks.nextOffset} onChange={setWorkOffset}/>
     </>}
    </div>}
   </>}
  </section>
  {!workOnly&&<section className="nc-assignment-section" aria-labelledby={`${id}-unit`}>
   <div className="nc-assignment-heading"><h4 id={`${id}-unit`}>{msg('阅读单元')}</h4>{value.workId&&<div className="nc-assignment-modes"><button type="button" aria-pressed={!value.unitId} onClick={()=>{setUnitPicker(false);onChange({...value,unitId:undefined});}}>{msg('新建阅读条目')}</button><button type="button" aria-pressed={!!value.unitId} aria-expanded={unitPicker} onClick={()=>{setUnitPicker(!unitPicker);setUnitOffset(0);}}>{msg('作为已有条目的新版本')}</button></div>}</div>
   {value.unitId?<div className="nc-assignment-selected"><div><span>{msg('作为已有条目的新版本')}</span><strong>{selectedUnit?.title??msg('正在读取阅读条目…')}</strong><small>{msg('沿用已有条目的类型和正文／番外分类。')}</small></div><button type="button" className="text-link" onClick={()=>setUnitPicker(!unitPicker)} aria-expanded={unitPicker}>{msg('更换条目')}</button></div>:<p className="nc-assignment-hint">{msg('导入内容将建立新的阅读条目。')}</p>}
   {unitError&&<p role="alert" className="error-message">{unitError}</p>}
   {unitPicker&&value.workId&&<div className="nc-assignment-picker" aria-label={msg('关联已有条目')}>
    <label className="field">{msg('搜索章节或卷册')}<input type="search" value={unitQuery} onChange={event=>{setUnitQuery(event.target.value);setUnitOffset(0);}}/></label>
    {!visibleUnits?<p role="status" className="nc-muted">{msg('正在读取阅读条目…')}</p>:visibleUnits.error?<p role="alert" className="error-message">{visibleUnits.error}</p>:<>
     <div className="nc-assignment-results">{visibleUnits.units.map(item=><button type="button" key={item.id} aria-pressed={value.unitId===item.id} onClick={()=>selectUnit(item)}><span><strong>{item.title}</strong><small>{kindLabel(item.kind)} · {roleLabel(item.role)}</small></span><b>{value.unitId===item.id?msg('已选择'):msg('选择此项')}</b></button>)}</div>
     {!visibleUnits.units.length&&<p className="nc-muted">{msg('没有找到阅读条目，请尝试其他关键词。')}</p>}
     <Pages offset={unitOffset} nextOffset={visibleUnits.nextOffset} onChange={setUnitOffset}/>
    </>}
   </div>}
   <div className="nc-assignment-classification"><label className="field">{msg('内容类型')}<Select aria-label={msg('内容类型')} disabled={!!value.unitId} value={selectedUnit?.kind??value.kind} onChange={event=>onChange({...value,kind:event.target.value as ImportAssignment['kind']})}><option value="unclassified">{msg('未分类')}</option><option value="chapter">{msg('话／章节')}</option><option value="volume">{msg('卷册')}</option><option value="book">{msg('单行本')}</option></Select></label><label className="field">{msg('内容性质')}<Select aria-label={msg('内容性质')} disabled={!!value.unitId} value={selectedUnit?.role??value.role??'unknown'} onChange={event=>onChange({...value,role:event.target.value as ImportAssignment['role']})}><option value="unknown">{msg('未分类')}</option><option value="main">{msg('正文')}</option><option value="extra">{msg('番外')}</option></Select></label></div>
  </section>}
 </div>;
}
