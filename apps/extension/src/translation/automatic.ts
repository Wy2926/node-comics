import {Sha256} from '../importers/hash';
import {pageTranslation} from '../reader/presentation';
import type {Mode,Page} from '../types';

export type ReadingTarget={entryId:string;page:Page;mode:Mode};
export type TranslationState={kind:'waiting'|'translating'|'upgrade'|'error'|'login';message:string;retryable?:boolean;retryLabel?:string;retryAction?:'translate'};
const digest=(value:unknown)=>new Sha256().update(new TextEncoder().encode(JSON.stringify(value))).digest();
export const targetKey=(entryId:string,page:Page,mode:Mode)=>digest([entryId,page.contentId??null,page.id,mode]);
export const advancesReadingWindow=(previous:readonly string[],next:string|undefined)=>next!==undefined&&previous.indexOf(next)>0;

/** Page snapshots and same-page scrolling never reset the local reading clock. */
export class ReadingWindow {
  targets:ReadingTarget[]=[];readyAt=0;prefetchAt=0;private signature='';private burstAt=0;
  update(targets:ReadingTarget[],now=performance.now(),immediate=false){
    const advancing=advancesReadingWindow(this.targets.map(t=>targetKey(t.entryId,t.page,t.mode)),targets[0]&&targetKey(targets[0].entryId,targets[0].page,targets[0].mode));
    this.targets=targets.slice(0,4);const signature=JSON.stringify(this.targets.map(t=>targetKey(t.entryId,t.page,t.mode)));
    if(signature===this.signature)return false;
    const first=!this.signature;this.signature=signature;
    if(now>=this.readyAt)this.burstAt=now;
    this.readyAt=first||immediate?now:Math.min(now+80,this.burstAt+200);this.prefetchAt=advancing?this.readyAt:now+150;return true;
  }
  ready(now=performance.now()){return now<this.readyAt?[]:this.targets.slice(0,now<this.prefetchAt?1:4);}
}
export function needsTranslation(page:Page,mode:Mode,language:string,scope:string){const t=pageTranslation(page,mode,language,scope);return !t.pending&&!t.ready&&!t.latest;}
