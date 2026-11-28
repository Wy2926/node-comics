import {useLayoutEffect,useRef,type RefObject} from 'react';
import {menuPosition,visibleViewport} from './visual-viewport';

/** 下拉层留在所属 dialog 内，用顶层弹出层避开滚动裁切，并随软键盘和锚点移动。 */
export function useSelectPopover(anchorRef:RefObject<HTMLElement|null>,listRef:RefObject<HTMLElement|null>,open:boolean,close:()=>void,placement:'auto'|'left'|'end'='auto',width=0){
  const dismiss=useRef(close);dismiss.current=close;
  useLayoutEffect(()=>{
    const anchor=anchorRef.current,list=listRef.current;
    if(!anchor||!list||!open)return;
    const native=typeof list.showPopover==='function';
    if(native)list.showPopover();
    function position(){
      if(!anchor||!list)return;
      const viewport=visibleViewport(),rect=anchor.getBoundingClientRect();
      list.style.width=`${Math.max(0,Math.min(Math.max(rect.width,width),viewport.width-16))}px`;
      const bounds=menuPosition(rect,viewport,width,list.scrollHeight+4,placement);
      for(const [key,value] of Object.entries(bounds))list.style[key as 'left'|'top'|'width'|'maxHeight']=value+'px';
    }
    position();
    const resize=new ResizeObserver(position);resize.observe(anchor);resize.observe(list);
    list.querySelectorAll('.nc-select-label[style]').forEach(node=>resize.observe(node));
    const scroll=(event:Event)=>{if(event.target!==list)position();};
    const outside=(event:PointerEvent)=>{if(!list.contains(event.target as Node)&&!anchor.contains(event.target as Node))dismiss.current();};
    window.addEventListener('resize',position);window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
    document.addEventListener('scroll',scroll,true);
    if(!native||list.popover==='manual')document.addEventListener('pointerdown',outside);
    return ()=>{
      resize.disconnect();window.removeEventListener('resize',position);window.visualViewport?.removeEventListener('resize',position);window.visualViewport?.removeEventListener('scroll',position);
      document.removeEventListener('scroll',scroll,true);document.removeEventListener('pointerdown',outside);
      if(native&&list.matches(':popover-open'))list.hidePopover();
    };
  },[anchorRef,listRef,open,placement,width]);
}
