import type {PageSnapshot, SourceSnapshot} from '../sources/contracts/source';
import type {Settings} from '../types';

export const IMMERSIVE_ORIGINAL_PORT='NC_IMMERSIVE_ORIGINAL';
export const IMMERSIVE_SOURCE_PORT='NC_IMMERSIVE_SOURCE';
export const immersiveSessionKey=(tabId:number)=>'nc-immersive:'+tabId;
export interface ImmersiveImage {
  id:string; url:string; width:number; height:number;
  referrerPolicy?:ReferrerPolicy;
}
export interface ImmersiveSession {
  id:string; navigationId:string; url:string; title:string; direction:'ltr'|'rtl';
  complete:boolean; knownTotal?:number; images:ImmersiveImage[];
  /** Only a validated adapter can produce a chapter manifest. Never stored in the library. */
  manifest?:PageSnapshot;
}
export interface ImmersiveResolve {session?:ImmersiveSession; settings:Settings;}
export interface ImmersiveBind {images:ImmersiveImage[]; snapshot?:SourceSnapshot;}
