import { useState } from 'react';
import { msg } from '../i18n/runtime';
import { Icon } from '../icons';
import { moveChoice, type ImageChoice } from '../sources';
import './source-images.css';

export function SourceImagePicker({choices,onChange,disabled=false}:{choices:ImageChoice[];onChange:(items:ImageChoice[])=>void;disabled?:boolean}){
 const [dragId,setDragId]=useState<string>();
 const selected=choices.filter(item=>item.selected);
 function reverse(){const reversed=[...selected].reverse();let n=0;onChange(choices.map(item=>item.selected?reversed[n++]:item));}
 return <section className="nc-image-picker" aria-label={msg("选择图片并排序")} aria-busy={disabled}>
  <div className="nc-image-toolbar"><strong>{msg("已选 {0} 张", {"0": selected.length})}</strong><div><button type="button" disabled={disabled||!choices.length} onClick={()=>onChange(choices.map(item=>({...item,selected:true})))}>{msg("全选当前")}</button><button type="button" disabled={disabled||!selected.length} onClick={()=>onChange(choices.map(item=>({...item,selected:false})))}>{msg("清空选择")}</button></div></div>
  <div className="nc-image-filter"><span>{msg("按来源清单选择")}</span><span>{msg("勾选后可拖动排序")}</span></div>
  <div className="nc-image-grid" role="list" aria-label={msg("发现的图片")}>
   {choices.map(item=>{
    const index=selected.findIndex(value=>value.id===item.id);
    return <article role="listitem" className={`nc-image-choice ${item.selected?'is-selected':''}`} key={item.id} data-image-id={item.id} draggable={!disabled&&item.selected} onDragStart={e=>{setDragId(item.id);e.dataTransfer.effectAllowed='move';e.dataTransfer.clearData();e.dataTransfer.setData('text/plain',item.id);}} onDragEnd={()=>setDragId(undefined)} onDragOver={e=>{if(dragId&&item.selected)e.preventDefault();}} onDrop={e=>{e.preventDefault();if(dragId&&!disabled&&item.selected)onChange(moveChoice(choices,dragId,item.id));setDragId(undefined);}}>
     <label className="nc-image-preview"><input type="checkbox" aria-label={msg("选择网页图片 {0}", {"0": item.order+1})} checked={item.selected} disabled={disabled} onChange={e=>onChange(choices.map(value=>value.id===item.id?{...value,selected:e.target.checked}:value))}/><span className="nc-image-placeholder"><Icon name="image"/><small>{msg("预览不可用时仍可选择")}</small></span><img key={item.url} src={item.kind==='page'?item.preview:item.url} loading="lazy" decoding="async" referrerPolicy="no-referrer" alt={msg("网页图片 {0}", {"0": item.order+1})} onError={e=>{e.currentTarget.hidden=true;}} draggable={!disabled&&item.selected}/><span className="nc-image-rank">{item.selected?String(index+1).padStart(2,'0'):msg("未选")}</span></label>
     <div className="nc-image-caption"><span>{item.width&&item.height?`${item.width} × ${item.height}`:msg("尺寸待确认")}<small>{msg("网页第 {0} 张", {"0": item.order+1})}</small></span><div><button type="button" disabled={disabled||index<=0} aria-label={msg("上移网页图片 {0}", {"0": item.order+1})} onClick={()=>onChange(moveChoice(choices,item.id,selected[index-1].id))}>↑</button><button type="button" disabled={disabled||index<0||index>=selected.length-1} aria-label={msg("下移网页图片 {0}", {"0": item.order+1})} onClick={()=>onChange(moveChoice(choices,item.id,selected[index+1].id))}>↓</button></div></div>
    </article>;
   })}
  </div>
  {!choices.length&&<div className="nc-image-empty"><Icon name="image"/><p>{msg("暂未发现图片。滚动原网页让图片加载，再刷新发现。")}</p></div>}
  <div className="nc-image-order"><span>{msg("编号即加入后的阅读顺序")}</span><button type="button" disabled={disabled||selected.length<2} onClick={reverse}>{msg("倒序")}</button><button type="button" disabled={disabled||!choices.length} onClick={()=>onChange([...choices].sort((a,b)=>a.order-b.order))}>{msg("恢复网页顺序")}</button></div>
 </section>;
}
