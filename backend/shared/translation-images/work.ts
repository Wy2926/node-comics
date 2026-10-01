let tail: Promise<unknown> = Promise.resolve();
/** One pixel operation per context and, where supported, per browser origin. */
export function imageWork<T>(work:()=>Promise<T>):Promise<T> {
  const next=tail.then(async()=>typeof navigator!=='undefined'&&navigator.locks
    ?await navigator.locks.request('nc-translation-pixels',work):await work());
  tail=next.catch(()=>undefined);return next;
}
