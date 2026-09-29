/** Memory only; keys include the API and login session, never persisted credentials. */
interface Entry {expires:number;value:Promise<unknown>;pending:boolean;data?:unknown;}
const entries=new Map<string,Entry>();
export const POLICY_TTL=5*60_000;
export function cachedRequest<T>(key:string,read:()=>Promise<T>,force=false):Promise<T>{
  const old=entries.get(key);
  if(old&&(old.pending||!force&&old.expires>Date.now()))return old.value as Promise<T>;
  const entry:Entry={expires:0,value:Promise.resolve(),pending:true};
  entry.value=Promise.resolve().then(read).then(value=>{entry.expires=Date.now()+POLICY_TTL;entry.pending=false;entry.data=value;return entries.get(key)!==entry&&entries.has(key)?entries.get(key)!.value:value;},error=>{if(entries.get(key)===entry)entries.delete(key);throw error;});
  entries.set(key,entry);
  // Keep abandoned login/API scopes bounded.
  if(entries.size>64)entries.delete(entries.keys().next().value!);
  return entry.value as Promise<T>;
}
export function peekCached<T>(key:string):T|undefined{return entries.get(key)?.data as T|undefined;}
export function cacheValue<T>(key:string,value:T){entries.set(key,{expires:Date.now()+POLICY_TTL,value:Promise.resolve(value),pending:false,data:value});}
