import {ByteCache} from '../../storage/cache';

export const INPUT_BUDGET_BYTES=128*1024*1024;
// Optional bytes, not task state. A miss restores the source and verifies the frozen hash.
const inputs=new ByteCache({name:'translation-inputs-v1',budgetBytes:INPUT_BUDGET_BYTES});
const key=(scope:string,sha256:string)=>JSON.stringify([scope,sha256]);
export const readInput=(scope:string,sha256:string)=>inputs.get(key(scope,sha256));
export const cacheInput=(scope:string,sha256:string,blob:Blob)=>inputs.put(key(scope,sha256),blob,{owner:scope});
