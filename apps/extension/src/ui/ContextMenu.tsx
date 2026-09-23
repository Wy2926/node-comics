import {useEffect,useLayoutEffect,useRef,useState,type HTMLAttributes} from 'react';
import './context-menu.css';

type Action={label:string;onSelect:()=>void;disabled?:boolean;danger?:boolean};
type Menu={x:number;y:number;label:string;actions:Action[];target:HTMLElement};

export function useContextMenu(){
 const [menu,setMenu]=useState<Menu>();
 const press=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),longPressed=useRef(false);
 const cancelPress=()=>{clearTimeout(press.current);press.current=undefined;};
 useEffect(()=>cancelPress,[]);
 function bind(label:string,actions:Action[]):HTMLAttributes<HTMLElement>{
  return {
   onContextMenu:event=>{event.preventDefault();cancelPress();const rect=event.currentTarget.getBoundingClientRect();setMenu({label,actions,target:event.currentTarget,x:event.clientX||rect.left+16,y:event.clientY||rect.top+16});},
   onKeyDown:event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();setMenu({label,actions,target:event.target as HTMLElement,x:rect.left+16,y:rect.top+16});}},
   onPointerDown:event=>{cancelPress();longPressed.current=false;if(event.pointerType!=='touch')return;const {clientX:x,clientY:y,currentTarget:target}=event;press.current=setTimeout(()=>{longPressed.current=true;setMenu({label,actions,x,y,target});},550);},
   onPointerMove:cancelPress,onPointerUp:cancelPress,onPointerCancel:cancelPress,
   onClickCapture:event=>{if(longPressed.current){event.preventDefault();event.stopPropagation();longPressed.current=false;}},
  };
 }
 const open=(target:HTMLElement,label:string,actions:Action[])=>{const rect=target.getBoundingClientRect();setMenu({label,actions,target,x:rect.left,y:rect.bottom+4});};
 return {bind,open,menu:menu&&<ContextMenu key={menu.x+':'+menu.y+':'+menu.label} menu={menu} onClose={()=>setMenu(undefined)}/>};
}

function ContextMenu({menu,onClose}:{menu:Menu;onClose:()=>void}){
 const ref=useRef<HTMLDivElement>(null);
 const latest=useRef(onClose);latest.current=onClose;
 useLayoutEffect(()=>{
  const node=ref.current!;node.showPopover();
  const rect=node.getBoundingClientRect();
  const root=document.documentElement,viewportWidth=Math.min(root.clientWidth,root.getBoundingClientRect().width);
  node.style.left=Math.max(8,Math.min(menu.x,viewportWidth-rect.width-8))+'px';
  node.style.top=Math.max(8,Math.min(menu.y,window.innerHeight-rect.height-8))+'px';
  node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
  return()=>{node.hidePopover();};
 },[menu]);
 const restoreFocus=()=>{const target=menu.target.matches('button')?menu.target:menu.target.querySelector<HTMLElement>('button');target?.focus({preventScroll:true});};
 useEffect(()=>{
  const dismiss=(event:Event)=>{if(!ref.current?.contains(event.target as Node))latest.current();};
  const scrollPositions=new Map<EventTarget,string>([[document,window.scrollX+':'+window.scrollY]]);
  for(let parent:HTMLElement|null=menu.target;parent;parent=parent.parentElement)scrollPositions.set(parent,parent.scrollLeft+':'+parent.scrollTop);
  const scroll=(event:Event)=>{
   const target=event.target;if(!target||!scrollPositions.has(target))return;
   const position=target===document?window.scrollX+':'+window.scrollY:(target as HTMLElement).scrollLeft+':'+(target as HTMLElement).scrollTop;
   // A scroll already completed before right-click can dispatch its event after the menu opens.
   if(position!==scrollPositions.get(target))latest.current();
  };
  const resize=()=>latest.current();
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();restoreFocus();latest.current();}};
  document.addEventListener('pointerdown',dismiss);document.addEventListener('scroll',scroll,true);document.addEventListener('keydown',escape);window.addEventListener('resize',resize);window.addEventListener('blur',resize);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('scroll',scroll,true);document.removeEventListener('keydown',escape);window.removeEventListener('resize',resize);window.removeEventListener('blur',resize);};
 },[menu]);
 return <div ref={ref} popover="manual" role="menu" aria-label={menu.label} className="nc-context-menu" style={{left:menu.x,top:menu.y}} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
  if(event.key==='Tab'){onClose();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],at=buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(at+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();
 }}>{menu.actions.map(action=><button key={action.label} role="menuitem" disabled={action.disabled} className={action.danger?'nc-danger-text':undefined} onClick={()=>{restoreFocus();onClose();action.onSelect();}}>{action.label}</button>)}</div>;
}
