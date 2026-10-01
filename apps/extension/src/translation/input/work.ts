import {RequestPool} from '../../concurrency';

const pool=new RequestPool(1);
/** Acquire before decoding. Uploads never hold this cross-context pixel-work lock. */
export function imageWork<T>(work:()=>Promise<T>):Promise<T> {
  return pool.run(async()=>typeof navigator!=='undefined'&&navigator.locks
    ?await navigator.locks.request('nc-translation-pixels',work):await work());
}
