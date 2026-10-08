import {useEffect,useLayoutEffect,useRef,useState,type HTMLAttributes} from 'react';
import {Icon} from '../icons';
import {visibleViewport} from './visual-viewport';
import './context-menu.css';

type Action={label:string;icon?:string;onSelect:()=>void;disabled?:boolean;danger?:boolean;visible?:()=>Promise<boolean>};
type Menu={x:number;y:number;label:string;actions:Action[];target:HTMLElement};

export function useContextMenu(active=true){
 const [menu,setMenu]=useState<Menu>();
 const press=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),longPressed=useRef(false);
 const pressPoint=useRef({x:0,y:0});
 const cancelPress=()=>{clearTimeout(press.current);press.current=undefined;};
 useEffect(()=>cancelPress,[]);
 useEffect(()=>{if(!active){cancelPress();setMenu(undefined);}},[active]);
 function bind(label:string,actions:Action[]):HTMLAttributes<HTMLElement>{
  return {
   onContextMenu:event=>{event.preventDefault();cancelPress();const rect=event.currentTarget.getBoundingClientRect();setMenu({label,actions,target:event.currentTarget,x:event.clientX||rect.left+16,y:event.clientY||rect.top+16});},
   onKeyDown:event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();setMenu({label,actions,target:event.target as HTMLElement,x:rect.left+16,y:rect.top+16});}},
   onPointerDown:event=>{cancelPress();longPressed.current=false;if(event.pointerType!=='touch')return;const {clientX:x,clientY:y,currentTarget:target}=event;pressPoint.current={x,y};press.current=setTimeout(()=>{longPressed.current=true;setMenu({label,actions,x,y,target});},550);},
   onPointerMove:event=>{if(Math.hypot(event.clientX-pressPoint.current.x,event.clientY-pressPoint.current.y)>10)cancelPress();},onPointerUp:cancelPress,onPointerCancel:cancelPress,
   onClickCapture:event=>{if(longPressed.current){event.preventDefault();event.stopPropagation();longPressed.current=false;}},
  };
 }
 const open=(target:HTMLElement,label:string,actions:Action[])=>{const rect=target.getBoundingClientRect();setMenu({label,actions,target,x:rect.left,y:rect.bottom+4});};
 return {bind,open,menu:active&&menu&&<ContextMenu key={menu.x+':'+menu.y+':'+menu.label} menu={menu} onClose={()=>setMenu(undefined)}/>};
}

function ContextMenu({menu,onClose}:{menu:Menu;onClose:()=>void}){
 const ref=useRef<HTMLDivElement>(null);
 const [resolved,setResolved]=useState<{menu:Menu;actions:Action[]}>();
 const actions=resolved?.menu===menu?resolved.actions:menu.actions.filter(action=>!action.visible);
 // Optional metadata belongs to an opened menu, never to every card in a list.
 useEffect(()=>{
  if(!menu.actions.some(action=>action.visible))return;
  let active=true;
  void Promise.all(menu.actions.map(async action=>{try{return !action.visible||await action.visible();}catch{return false;}}))
   .then(visible=>{if(active)setResolved({menu,actions:menu.actions.filter((_,index)=>visible[index])});});
  return()=>{active=false;};
 },[menu]);
 const latest=useRef(onClose);latest.current=onClose;
 useLayoutEffect(()=>{
  const node=ref.current!;if(typeof node.showPopover==='function'&&!node.matches(':popover-open'))node.showPopover();
  const viewport=visibleViewport();
  node.style.maxWidth=Math.max(0,viewport.width-16)+'px';
  node.style.maxHeight=Math.max(0,viewport.height-16)+'px';
  const rect=node.getBoundingClientRect();
  node.style.left=Math.max(viewport.left+8,Math.min(menu.x,viewport.left+viewport.width-rect.width-8))+'px';
  node.style.top=Math.max(viewport.top+8,Math.min(menu.y,viewport.top+viewport.height-rect.height-8))+'px';
  if(!node.contains(document.activeElement))node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
 },[menu,actions]);
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
  document.addEventListener('pointerdown',dismiss);document.addEventListener('scroll',scroll,true);document.addEventListener('keydown',escape);window.addEventListener('resize',resize);window.addEventListener('blur',resize);window.visualViewport?.addEventListener('resize',resize);window.visualViewport?.addEventListener('scroll',resize);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('scroll',scroll,true);document.removeEventListener('keydown',escape);window.removeEventListener('resize',resize);window.removeEventListener('blur',resize);window.visualViewport?.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('scroll',resize);};
 },[menu]);
 return <div ref={ref} popover="manual" role="menu" aria-label={menu.label} className="nc-context-menu" data-popover-fallback-open={typeof HTMLElement.prototype.showPopover!=='function'||undefined} style={{left:menu.x,top:menu.y}} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
  if(event.key==='Tab'){onClose();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],at=buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(at+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();
 }}>{actions.map(action=><button key={action.label} role="menuitem" disabled={action.disabled} className={action.danger?'nc-danger-text':undefined} onClick={()=>{restoreFocus();onClose();action.onSelect();}}>{action.icon&&<Icon name={action.icon} size={18}/>}<span>{action.label}</span></button>)}</div>;
}
