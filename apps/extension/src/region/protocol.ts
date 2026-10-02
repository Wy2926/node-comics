import type {TranslationState} from '../translation/automatic';

export interface RegionRect {x:number;y:number;width:number;height:number;}
export interface RegionViewport {
  width:number;height:number;devicePixelRatio:number;scrollX:number;scrollY:number;
  visualViewport?:{width:number;height:number;offsetLeft:number;offsetTop:number;scale:number};
}
export interface RegionIdentity {
  url:string;navigationId:string;enabled:boolean;dismissedUrl?:string;
  generation:number;selectionId?:string;viewport:RegionViewport;
}
export interface RegionRequest {
  type:'NC_REGION_CAPTURE'|'NC_REGION_SUBMIT'|'NC_REGION_TICK'|'NC_REGION_WAIT'|'NC_REGION_RETRY'|'NC_REGION_CLOSE'|'NC_REGION_PAUSE'|'NC_REGION_OPEN';
  navigationId:string;generation:number;selectionId?:string;rect?:RegionRect;viewport?:RegionViewport;
  view?:'settings'|'account';
}
export interface RegionResponse {
  selectionId:string;width:number;height:number;rect:RegionRect;
  state?:TranslationState;resultKey?:string;scope?:string;language?:string;
  submitted:boolean;hasPending?:boolean;retryAfterMs?:number;requiresInternet?:boolean;
}
export interface RegionImageRequest {
  navigationId:string;generation:number;selectionId:string;kind:'source'|'result';resultKey?:string;
}
export const REGION_IMAGE_PORT='NC_REGION_IMAGE';
export const regionActivationKey=(tabId:number)=>'nc-region:'+tabId;
