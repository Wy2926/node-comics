import type {TranslationState} from '../translation/automatic';
import type { Mode } from '../types';

export interface InlineImage {id:string;url:string;width:number;height:number;referrerPolicy?:ReferrerPolicy;}
export interface InlineRequest {type:'NC_INLINE_TICK'|'NC_INLINE_WAIT'|'NC_INLINE_IMAGE';navigationId:string;generation:number;images:InlineImage[];retryId?:string;refreshRights?:boolean;resultKey?:string;}
export interface InlineResult {id:string;state?:TranslationState;resultKey?:string;resultMode?:Mode;pending?:boolean;}
export interface InlineResponse {mode:Mode;language:string;scope:string;items:InlineResult[];requiresInternet?:boolean;retryAfterMs?:number;hasPending?:boolean;needsSubmit?:boolean;analyticsChannel?:'official'|'local';}
