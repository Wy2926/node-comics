import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import type {ChannelField} from '../translation/channels/contracts';
import {useSelectPopover} from './useSelectPopover';

export function ServiceModelInput({field,value,models,busy,disabled,invalid,onChange,onFetch}:{
  field:ChannelField;value:string;models?:readonly string[];busy:boolean;disabled:boolean;invalid:boolean;onChange:(id:string)=>void;onFetch:()=>void;
}){
  const id=useId(),popupId=id+'-options',input=useRef<HTMLInputElement>(null),anchor=useRef<HTMLDivElement>(null),list=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[filter,setFilter]=useState(''),[active,setActive]=useState(-1),touch=useRef(false);
  const expanded=open&&!!models&&!disabled,options=expanded?models.filter(item=>item.toLowerCase().includes(filter)):[];
  function close(){setOpen(false);setActive(-1);touch.current=false;}
  function show(){setFilter('');setActive(-1);setOpen(true);}
  function choose(item:string){onChange(item);input.current?.focus({preventScroll:true});close();}
  useSelectPopover(anchor,list,expanded,close);
  useEffect(()=>{
    if(models){input.current?.focus();show();}else close();
  },[models]);
  useLayoutEffect(()=>{
    const node=list.current,option=node?.children[active];
    if(!expanded||!node||!option)return;
    const box=option.getBoundingClientRect(),frame=node.getBoundingClientRect();
    if(box.bottom>frame.bottom)node.scrollTop+=box.bottom-frame.bottom;
    if(box.top<frame.top)node.scrollTop-=frame.top-box.top;
  },[active,expanded]);
  function keyDown(event:KeyboardEvent<HTMLInputElement>){
    if(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229||event.ctrlKey||event.metaKey)return;
    if(event.key==='Escape'&&expanded){event.preventDefault();event.stopPropagation();close();}
    else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();event.stopPropagation();
      if(!models){if(!busy)onFetch();return;}
      if(!expanded)show();
      const last=(expanded?options:models).length-1;
      setActive(last<0?-1:event.key==='ArrowDown'?Math.min(last,expanded?active+1:0):!expanded||active<0?last:Math.max(0,active-1));
    }else if(event.key==='Enter'){
      // 只有显式高亮的项才回填；直接输入的 ID 即使只匹配某个前缀也始终可用。
      event.preventDefault();event.stopPropagation();if(expanded&&options[active])choose(options[active]);else close();
    }else if(event.key==='Tab')close();
  }
  return <div className="nc-model-field">
    <label htmlFor={id}>{field.label}</label>
    <div className="nc-model-input-row">
      <div className="nc-model-combo" ref={anchor}>
        <input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={popupId}
          aria-activedescendant={expanded&&active>=0&&options[active]?popupId+'-'+active:undefined} aria-describedby={id+'-hint'} aria-invalid={invalid||undefined}
          data-field="model" value={value} disabled={disabled} required maxLength={field.maxLength} placeholder={field.placeholder} autoComplete="off" spellCheck={false}
          onClick={()=>{if(!expanded&&models)show();}} onBlur={()=>{if(!touch.current)close();}} onKeyDown={keyDown}
          onChange={event=>{const next=event.target.value;onChange(next);setFilter(next.trim().toLowerCase());setActive(-1);setOpen(true);}}/>
        <button className="nc-combo-toggle" type="button" tabIndex={-1} aria-label={msg('搜索模型')} title={msg('搜索模型')} disabled={disabled}
          onMouseDown={event=>event.preventDefault()} onClick={()=>{input.current?.focus();if(!models){if(!busy)onFetch();}else if(expanded)close();else show();}}>
          <Icon name="chevron" size={16}/>
        </button>
      </div>
      <button className="button secondary small" type="button" disabled={busy||disabled} onClick={onFetch}><Icon name="refresh" size={16}/>{msg('获取模型')}</button>
    </div>
    <small id={id+'-hint'} className="nc-muted">{msg('可从列表选择，也可直接填写模型 ID。')}</small>
    <div ref={list} id={popupId} popover="manual" hidden={!expanded} role="listbox" aria-label={msg('搜索模型')} className="nc-select-list nc-model-list"
      data-popover-fallback-open={expanded&&typeof HTMLElement.prototype.showPopover!=='function'||undefined}
      onPointerDown={event=>{if(event.pointerType==='touch')touch.current=true;else event.preventDefault();}} onMouseDown={event=>event.preventDefault()}
      onPointerUp={()=>{if(touch.current){touch.current=false;input.current?.focus({preventScroll:true});}}} onPointerCancel={()=>{touch.current=false;}}>
      {expanded&&(options.length?options.map((item,index)=><div key={item} id={popupId+'-'+index} role="option" className="nc-select-option" aria-selected={item===value} data-active={active===index||undefined}
        onPointerMove={event=>{if(event.pointerType!=='touch')setActive(index);}} onClick={()=>choose(item)}>
        <span>{item}</span>{item===value&&<Icon name="check" size={16}/>}
      </div>):<div role="option" aria-disabled="true" aria-selected="false" className="nc-select-option">{models?.length?msg('未找到'):msg('服务未返回模型，可手动填写模型 ID。')}</div>)}
    </div>
  </div>;
}
