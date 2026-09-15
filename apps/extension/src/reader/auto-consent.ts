import {ApiError} from '../api';
import type {Mode,QuotaKind} from '../types';

// Approval is local to an account/service/mode/language, but follows the reader between books.
export type AutoConsents = Record<string, {version:string;quotaKind:QuotaKind}>;
const key = 'nc-auto-consents-pages-v1';
export const autoConsentScope = (owner:string|undefined, origin:string, language:string, mode:Mode) => JSON.stringify([owner,origin,language,mode]);
export function readAutoConsents():AutoConsents {
  try {
    const value = JSON.parse(localStorage.getItem(key)??'{}');
    const valid:AutoConsents={};
    for(const [scope,v] of Object.entries(value))if(v&&typeof v==='object'&&'version' in v&&typeof v.version==='string'&&v.version&&'quotaKind' in v&&['classic_daily','classic_unlimited','redraw_monthly','redraw_grant'].includes(String(v.quotaKind)))valid[scope]={version:v.version,quotaKind:v.quotaKind as QuotaKind};
    return valid;
  } catch {return {};}
}
export function saveAutoConsents(value:AutoConsents) {localStorage.setItem(key,JSON.stringify(value));}
// Only preparation/explicitly rejected submissions may be retried; never an uncertain POST.
export function retryablePreparation(error:unknown) {
  return error instanceof ApiError && (error.status===0 || error.status===408 || error.status===429 || error.status>=500 || ['PREVIEW_EXPIRED','PREVIEW_CHANGED','DAILY_QUOTA_EXHAUSTED','REDRAW_QUOTA_EXHAUSTED','QUOTA_CONFLICT'].includes(error.code));
}
