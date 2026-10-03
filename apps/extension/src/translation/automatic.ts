import {Sha256} from '../importers/hash';
import {pageTranslation} from '../reader/presentation';
import type {Mode,Page} from '../types';

export type ReadingTarget={entryId:string;page:Page;mode:Mode};
export type TranslationState={kind:'waiting'|'translating'|'upgrade'|'error'|'login';message:string;retryable?:boolean;retryLabel?:string;retryAction?:'translate'};
const digest=(value:unknown)=>new Sha256().update(new TextEncoder().encode(JSON.stringify(value))).digest();
export const targetKey=(entryId:string,page:Page,mode:Mode)=>digest([entryId,page.contentId??null,page.id,mode]);
export const READING_TARGETS=4,MAX_READING_TARGETS=5;

/** Expand once per actual page, not once per prefetched page. Short pages need an earlier start. */
export class ReadingProgress {
  private key='';private expanded=false;
  update(key:string,top:number,height:number,viewport:number){
    if(key!==this.key){this.key=key;this.expanded=false;}
    if(key&&height>0&&viewport>0&&top<viewport&&Math.max(0,-top)>=Math.max(0,Math.min(height/3,height-viewport)))this.expanded=true;
    return this.expanded?MAX_READING_TARGETS:READING_TARGETS;
  }
}

/** Page snapshots and same-page scrolling never reset the local reading clock. */
export class ReadingWindow<T=ReadingTarget> {
  targets:T[]=[];readyAt=0;prefetchAt=0;private signature='';private burstAt=0;
  constructor(private readonly key:(target:T)=>string=(target=>{const t=target as ReadingTarget;return targetKey(t.entryId,t.page,t.mode);})){}
  update(targets:T[],now=performance.now(),immediate=false){
    const previous=this.targets.map(this.key),next=targets[0]&&this.key(targets[0]);
    const samePage=next!==undefined&&previous[0]===next,advancing=next!==undefined&&previous.indexOf(next)>0;
    this.targets=targets.slice(0,MAX_READING_TARGETS);const signature=JSON.stringify(this.targets.map(this.key));
    if(signature===this.signature)return false;
    const first=!this.signature;this.signature=signature;
    if(now>=this.readyAt)this.burstAt=now;
    this.readyAt=first||immediate||samePage?now:Math.min(now+80,this.burstAt+200);
    if(!samePage)this.prefetchAt=advancing?this.readyAt:now+150;return true;
  }
  ready(now=performance.now()){return now<this.readyAt?[]:this.targets.slice(0,now<this.prefetchAt?1:MAX_READING_TARGETS);}
}
export function needsTranslation(page:Page,mode:Mode,language:string,scope:string){const t=pageTranslation(page,mode,language,scope);return !t.pending&&!t.ready&&!t.latest;}
