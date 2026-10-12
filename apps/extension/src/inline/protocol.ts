import type {TranslationState} from '../translation/automatic';
import type { Mode } from '../types';
import type {ProcessingState} from '../image-processing/contracts';

export interface InlineImage {id:string;url:string;width:number;height:number;referrerPolicy?:ReferrerPolicy;}
export interface InlineRequest {type:'NC_INLINE_TICK'|'NC_INLINE_WAIT'|'NC_INLINE_IMAGE';navigationId:string;generation:number;images:InlineImage[];
  /** TICK carries the actual reading window separately from unfinished translation work. */
  readingImages?:InlineImage[];retryId?:string;retryEnhancementId?:string;refreshRights?:boolean;resultKey?:string;deferRemote?:'backoff'|'offline';}
export interface InlineResult {id:string;state?:TranslationState;resultKey?:string;resultMode?:Mode;pending?:boolean;enhancement?:ProcessingState;}
export interface InlineResponse {contextId:string;revision:number;mode:Mode;language:string;scope:string;items:InlineResult[];requiresInternet?:boolean;retryAfterMs?:number;hasPending?:boolean;needsSubmit?:boolean;analyticsChannel?:'official'|'local';}
