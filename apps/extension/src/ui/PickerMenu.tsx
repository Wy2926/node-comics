import {useId,useLayoutEffect,useRef,type ReactNode,type KeyboardEvent} from 'react';
import {Icon} from '../icons';
import {menuPosition,visibleViewport} from './visual-viewport';
import './select.css';
import './picker-menu.css';

/** An anchored picker with real buttons/forms, rather than interactive children inside listbox options. */
export function PickerMenu({id:providedId,label,descriptionId,open,onOpenChange,trigger,children,viewKey='',busy=false,width=380,className=''}:{
  id?:string;label:string;descriptionId?:string;open:boolean;onOpenChange:(open:boolean)=>void;
  trigger:ReactNode;children:ReactNode;viewKey?:string;busy?:boolean;width?:number;className?:string;
}){
  const generatedId=useId(),id=providedId??generatedId,button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const latest=useRef(onOpenChange);latest.current=onOpenChange;
  function close(restore=true){latest.current(false);if(restore)button.current?.focus({preventScroll:true});}
  useLayoutEffect(()=>{
    const anchor=button.current,node=panel.current;
    if(!open||!anchor||!node)return;
    const native=typeof node.showPopover==='function';
    if(native)node.showPopover();
    const position=()=>{
      const viewport=visibleViewport(),rect=anchor.getBoundingClientRect();
      node.style.width=Math.min(Math.max(rect.width,width),viewport.width-16)+'px';
      const bounds=menuPosition(rect,viewport,width,node.scrollHeight+4,'end',560);
      for(const [key,value] of Object.entries(bounds))node.style[key as 'left'|'top'|'width'|'maxHeight']=value+'px';
    };
    position();
    const resize=new ResizeObserver(position);resize.observe(anchor);resize.observe(node);
    if(node.firstElementChild)resize.observe(node.firstElementChild);
    const scroll=(event:Event)=>{if(!(event.target instanceof Node)||!node.contains(event.target))position();};
    const dismiss=(event:PointerEvent)=>{if(!node.contains(event.target as Node)&&!anchor.contains(event.target as Node))close(false);};
    window.addEventListener('resize',position);window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
    document.addEventListener('scroll',scroll,true);
    if(!native)document.addEventListener('pointerdown',dismiss);
    return()=>{
      resize.disconnect();window.removeEventListener('resize',position);window.visualViewport?.removeEventListener('resize',position);window.visualViewport?.removeEventListener('scroll',position);
      document.removeEventListener('scroll',scroll,true);document.removeEventListener('pointerdown',dismiss);
      if(native&&node.matches(':popover-open'))node.hidePopover();
    };
  },[open,width]);
  useLayoutEffect(()=>{
    const node=panel.current;
    if(open&&node){
      node.scrollTop=0;
      (node.querySelector<HTMLElement>('input:not(:disabled)')??node.querySelector<HTMLElement>('[aria-pressed=true]:not(:disabled)')??node.querySelector<HTMLElement>('button:not(:disabled)'))?.focus({preventScroll:true});
    }
  },[open,viewKey]);
  function navigate(event:KeyboardEvent<HTMLDivElement>){
    // Nested selects retain their own navigation; editable fields retain cursor movement.
    if(event.defaultPrevented||event.nativeEvent.isComposing)return;
    event.stopPropagation();
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if((event.target as HTMLElement).closest('input,textarea,[role=combobox],form')||event.altKey||event.ctrlKey||event.metaKey)return;
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();
    const node=panel.current!,items=[...node.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')],at=items.indexOf(document.activeElement as HTMLElement);
    const index=event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,at+(event.key==='ArrowDown'?1:-1)));
    const next=items[index];next?.focus({preventScroll:true});
    if(next){const rect=next.getBoundingClientRect(),bounds=node.getBoundingClientRect();if(rect.bottom>bounds.bottom)node.scrollTop+=rect.bottom-bounds.bottom+8;if(rect.top<bounds.top)node.scrollTop-=bounds.top-rect.top+8;}
  }
  return <>
    <button ref={button} id={id} type="button" className="nc-select nc-picker-trigger" aria-label={label} aria-describedby={descriptionId}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id+'-menu'} aria-busy={busy||undefined}
      onClick={()=>onOpenChange(!open)} onKeyDown={event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();event.stopPropagation();onOpenChange(true);}}}>
      <span className="nc-picker-trigger-value">{trigger}</span><Icon name="chevron" size={16} className="nc-select-chevron"/>
    </button>
    <div ref={panel} id={id+'-menu'} popover="auto" role="dialog" aria-label={label} className={'nc-select-list nc-picker-menu '+className} hidden={!open}
      data-popover-fallback-open={open&&typeof HTMLElement.prototype.showPopover!=='function'||undefined}
      onToggle={event=>{if(event.target===event.currentTarget&&event.newState==='closed')latest.current(false);}} onKeyDown={navigate}
      onBlur={event=>{if(event.relatedTarget instanceof Node&&!event.currentTarget.contains(event.relatedTarget)&&event.relatedTarget!==button.current)close(false);}}>
      {open&&children}
    </div>
  </>;
}
