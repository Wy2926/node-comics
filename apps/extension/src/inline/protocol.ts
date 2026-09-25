import type { TranslationState } from '../translation/automatic';
import type { Mode } from '../types';

export interface InlineImage {id:string;url:string;width:number;height:number;referrerPolicy?:ReferrerPolicy;}
export interface InlineRequest {type:'NC_INLINE_TICK'|'NC_INLINE_WAIT'|'NC_INLINE_IMAGE';navigationId:string;generation:number;images:InlineImage[];retryId?:string;refreshRights?:boolean;resultKey?:string;}
export interface InlineResult {id:string;state?:TranslationState;resultKey?:string;}
export interface InlineResponse {mode:Mode;language:string;scope:string;items:InlineResult[];requiresInternet?:boolean;retryAfterMs?:number;hasPending?:boolean;needsSubmit?:boolean;}
export interface InlineImageResponse {resultKey:string;data:string;}

export function readingImages<T extends {rect:{top:number;bottom:number;left:number;right:number}}>(items:T[],width:number,height:number,direction:'ltr'|'rtl'='ltr'){
  const visible=items.filter(i=>i.rect.bottom>0&&i.rect.top<height&&i.rect.right>0&&i.rect.left<width);
  if(!visible.length)return [];
  const focus=Math.min(height*.3,240);
  const current=[...visible].sort((a,b)=>Math.max(0,a.rect.top-focus,focus-a.rect.bottom)-Math.max(0,b.rect.top-focus,focus-b.rect.bottom)||a.rect.top-b.rect.top||(direction==='rtl'?b.rect.right-a.rect.right:a.rect.left-b.rect.left))[0];
  return items.slice(items.indexOf(current),items.indexOf(current)+4);
}
