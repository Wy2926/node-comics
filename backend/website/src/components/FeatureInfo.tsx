import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';

export function tooltipPosition(anchor:{left:number;right:number;top:number;bottom:number},size:{width:number;height:number},viewport:{width:number;height:number}){
  const margin=12;
  const left=Math.max(margin,Math.min((anchor.left+anchor.right-size.width)/2,viewport.width-size.width-margin));
  const top=anchor.bottom+size.height<=viewport.height-margin?anchor.bottom:Math.max(margin,anchor.top-size.height);
  return {left,top};
}

export default function FeatureInfo({label,detail}:{label:string;detail:string}){
  const id=useId(),root=useRef<HTMLSpanElement>(null),trigger=useRef<HTMLButtonElement>(null),tip=useRef<HTMLSpanElement>(null);
  const [open,setOpen]=useState(false);
  useLayoutEffect(()=>{
    if(!open||!trigger.current||!tip.current)return;
    const position=tooltipPosition(trigger.current.getBoundingClientRect(),tip.current.getBoundingClientRect(),{width:innerWidth,height:innerHeight});
    Object.assign(tip.current.style,{left:`${position.left}px`,top:`${position.top}px`});
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};
    const move=(event:Event)=>{if(!(event.target instanceof Node&&tip.current?.contains(event.target)))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape);
    window.addEventListener('resize',move);
    window.addEventListener('scroll',move,true);
    return()=>{
      document.removeEventListener('pointerdown',outside);
      document.removeEventListener('keydown',escape);
      window.removeEventListener('resize',move);
      window.removeEventListener('scroll',move,true);
    };
  },[open]);
  return <span className="feature-info" ref={root} onPointerEnter={event=>{if(event.pointerType!=='touch')setOpen(true);}} onPointerLeave={event=>{if(event.pointerType!=='touch'&&!trigger.current?.matches(':focus-visible'))setOpen(false);}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false);}}>
    <button className="feature-info-trigger" type="button" ref={trigger} aria-label={label} aria-describedby={id} aria-controls={id} aria-expanded={open} onFocus={event=>{if(event.currentTarget.matches(':focus-visible'))setOpen(true);}} onClick={()=>setOpen(true)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v6 M12 7v.2"/></svg>
    </button>
    <span className="feature-info-tip" id={id} role="tooltip" ref={tip} hidden={!open}><span className="feature-info-content">{detail}</span></span>
  </span>;
}
