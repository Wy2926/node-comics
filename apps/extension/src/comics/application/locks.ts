let localQueue: Promise<unknown> = Promise.resolve();
export async function sourceLock<T>(action:()=>Promise<T>):Promise<T>{
  if(globalThis.navigator?.locks)return navigator.locks.request('nc-catalog-source-import',action);
  const pending=localQueue.catch(()=>{}).then(action);localQueue=pending.catch(()=>{});return pending;
}
