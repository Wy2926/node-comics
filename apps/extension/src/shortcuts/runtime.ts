import {commandById,type ShortcutHandlers,type ShortcutOverrides} from './catalog';
import {bindingFromEvent} from './keys';
import {activeBindings} from './model';

const protectedControl='input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="listbox"],[role="menu"],[role="menuitem"],[role="slider"],[role="spinbutton"],[role="tablist"],[data-shortcuts-ignore]';
function protectedTarget(event:KeyboardEvent):boolean {
  // composedPath sees inputs inside open Shadow DOM; closed roots still protect their host.
  return event.composedPath().some(node=>{
    if(!node||typeof (node as Element).closest!=='function')return false;
    const element=node as Element;
    if(element.closest(protectedControl))return true;
    if(['Space','Enter'].includes(event.code)&&element.closest('button,a[href],[role="button"]'))return true;
    return ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.code)&&!!element.closest('[role="group"]');
  });
}

/** Top-layer placement alone is not modal: scrollbars and passive hints also use popovers. */
export function hasShortcutOverlay(document:Document):boolean {
  const interactive=':is([role="menu"],[role="listbox"],[role="dialog"])';
  const popover=typeof document.defaultView?.HTMLElement.prototype.showPopover==='function'
    ? `,[popover]:popover-open${interactive}` : '';
  return !!document.querySelector(`dialog[open],[role="dialog"][aria-modal="true"],[data-popover-fallback-open]${interactive}${popover}`);
}

export function bindShortcuts(target:Window,handlers:ShortcutHandlers,options:{getOverrides:()=>ShortcutOverrides;enabled?:()=>boolean}):()=>void {
  let previous:ShortcutOverrides|undefined,bindings=activeBindings({});
  const pending=new Set<string>();
  const key=(event:KeyboardEvent)=>{
    if(event.defaultPrevented||options.enabled?.()===false||protectedTarget(event))return;
    const binding=bindingFromEvent(event);if(!binding)return;
    const overrides=options.getOverrides();
    if(overrides!==previous){previous=overrides;bindings=activeBindings(overrides);}
    const candidates=bindings.get(binding);if(!candidates)return;
    // Query only on a matching key, never scan images or watch the document.
    if(hasShortcutOverlay(target.document))return;
    for(const id of candidates){
      const handler=handlers[id];if(!handler)continue;
      if((event.repeat||pending.has(event.code))&&!commandById.get(id)?.repeat)return;
      if(handler(event)===false)continue;
      pending.add(event.code);event.preventDefault();return;
    }
  };
  const release=(event:KeyboardEvent)=>pending.delete(event.code);
  const clear=()=>pending.clear();
  target.addEventListener('keydown',key);
  target.addEventListener('keyup',release);
  target.addEventListener('blur',clear);
  return()=>{target.removeEventListener('keydown',key);target.removeEventListener('keyup',release);target.removeEventListener('blur',clear);pending.clear();};
}
