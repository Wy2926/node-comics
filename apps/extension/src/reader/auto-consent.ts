import {ApiError} from '../api';
import type {Mode} from '../types';

// Approval is local to an account/service/mode/language, but follows the reader between books.
export type AutoConsents = Record<string, {unitCost:number}>;
const key = 'nc-auto-consents-v1';
export const autoConsentScope = (owner:string|undefined, origin:string, language:string, mode:Mode) => JSON.stringify([owner,origin,language,mode]);
export function readAutoConsents():AutoConsents {
  try {
    const value = JSON.parse(localStorage.getItem(key)??'{}');
    const valid:AutoConsents={};
    for(const [scope,v] of Object.entries(value))if(v && typeof v==='object' && 'unitCost' in v && typeof v.unitCost==='number' && Number.isFinite(v.unitCost) && v.unitCost>=0)valid[scope]={unitCost:v.unitCost};
    return valid;
  } catch {return {};}
}
export function saveAutoConsents(value:AutoConsents) {localStorage.setItem(key,JSON.stringify(value));}
// Only preparation/explicitly rejected submissions may be retried; never an uncertain POST.
export function retryablePreparation(error:unknown) {
  return error instanceof ApiError && (error.status===0 || error.status===408 || error.status===429 || error.status>=500 || ['QUOTE_EXPIRED','QUOTE_CHANGED','INSUFFICIENT_QUOTA'].includes(error.code));
}
