import {useEffect,useMemo,useState,type RefObject} from 'react';
import type {Settings} from '../types';

type Props={pages:readonly {key:string}[];currentKey:string;mountedKeys:string[];layout:Settings['layout'];viewport:RefObject<HTMLDivElement|null>;cells:RefObject<Map<string,HTMLDivElement>>};

/** Original resolution never excludes a neighbor or a page already on screen. */
export function useImageWindow({pages,currentKey,mountedKeys,layout,viewport,cells}:Props){
 const [visible,setVisible]=useState<ReadonlySet<string>>(()=>new Set());
 const mountedSignature=JSON.stringify(mountedKeys);
 useEffect(()=>{
  const root=viewport.current;if(!root||layout==='single')return;
  let active=true;
  const keys:string[]=JSON.parse(mountedSignature),nodes=new Map<Element,string>(),intersecting=new Set<string>();
  for(const key of keys){const node=cells.current.get(key);if(node)nodes.set(node,key);}
  const observer=new IntersectionObserver(entries=>{
   if(!active)return;
   for(const entry of entries){const key=nodes.get(entry.target);if(!key)continue;if(entry.isIntersecting)intersecting.add(key);else intersecting.delete(key);}
   setVisible(previous=>previous.size===intersecting.size&&[...intersecting].every(key=>previous.has(key))?previous:new Set(intersecting));
  },{root,threshold:0});
  for(const node of nodes.keys())observer.observe(node);
  return()=>{active=false;observer.disconnect();};
 },[mountedSignature,layout,viewport,cells]);
 return useMemo(()=>{
  const selected=new Set<string>(),current=pages.findIndex(page=>page.key===currentKey),mounted=new Set<string>(JSON.parse(mountedSignature));
  if(current<0)return selected;
  for(const delta of layout==='single'?[0]:[0,1,-1]){const page=pages[current+delta];if(page&&mounted.has(page.key))selected.add(page.key);}
  if(layout==='continuous')for(const page of pages)if(mounted.has(page.key)&&visible.has(page.key))selected.add(page.key);
  return selected;
 },[pages,currentKey,mountedSignature,layout,visible]);
}
