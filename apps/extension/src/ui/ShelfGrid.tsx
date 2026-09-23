import {useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import type {Comic} from '../comics/domain';

export type ShelfView={scrollTop:number;search:string;sort:string};
type Geometry={columns:number;stride:number;gap:number;top:number;scroll:number;height:number;measured:boolean};

/** Only the visible rows and two neighboring rows own card state, source metadata and image URLs. */
export function ShelfGrid({comics,view,children}:{comics:Comic[];view:RefObject<ShelfView>;children:(comic:Comic)=>ReactNode}){
 const container=useRef<HTMLDivElement>(null),grid=useRef<HTMLDivElement>(null),restored=useRef(false);
 const [geometry,setGeometry]=useState<Geometry>({columns:2,stride:420,gap:24,top:0,scroll:view.current.scrollTop,height:window.innerHeight,measured:false});
 const rows=Math.ceil(comics.length/geometry.columns),firstVisible=Math.floor(Math.max(0,geometry.scroll-geometry.top)/geometry.stride);
 const startRow=Math.max(0,Math.min(Math.max(0,rows-1),firstVisible-2)),endRow=Math.min(rows,Math.ceil((Math.max(0,geometry.scroll-geometry.top)+geometry.height)/geometry.stride)+2);
 const first=startRow*geometry.columns,last=Math.max(first+geometry.columns,endRow*geometry.columns);
 useLayoutEffect(()=>{
  const root=container.current!,list=grid.current!;let frame=0;
  function measure(){
   const style=getComputedStyle(list),columns=style.gridTemplateColumns.split(' ').length,gap=parseFloat(style.rowGap)||0;
   const card=list.firstElementChild?.getBoundingClientRect(),top=root.getBoundingClientRect().top+window.scrollY;
   const scroll=restored.current?window.scrollY:view.current.scrollTop;
   if(restored.current)view.current.scrollTop=scroll;
   setGeometry(previous=>{
    const next={columns,stride:card?card.height+gap:previous.stride,gap,top,scroll,height:window.innerHeight,measured:true};
    return Object.keys(next).every(key=>next[key as keyof Geometry]===previous[key as keyof Geometry])?previous:next;
   });
  }
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
  const observer=new ResizeObserver(schedule);observer.observe(root);observer.observe(list);
  measure();window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);
  return()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);};
 },[view]);
 useLayoutEffect(()=>{
  if(!geometry.measured||restored.current)return;
  restored.current=true;window.scrollTo({top:view.current.scrollTop,behavior:'instant'});
 },[geometry.measured,view]);
 return <div ref={container} className="nc-shelf-window" data-rendered-count={Math.min(comics.length,last)-first} style={{height:Math.max(0,rows*geometry.stride-geometry.gap)}}>
  <div ref={grid} className="nc-books grid nc-shelf-grid" style={{transform:`translateY(${startRow*geometry.stride}px)`}}>{comics.slice(first,last).map(children)}</div>
 </div>;
}
