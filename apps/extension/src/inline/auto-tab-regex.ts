import RegexWorker from './auto-tab-regex.worker?worker';

export interface AutoTabRegexResult { matches: boolean; error?: 'invalid' | 'timeout' | 'unavailable'; }

/** Disposable workers keep user expressions off the UI/background event loop. */
async function evaluateRegex(pattern: string, url: string, signal?: AbortSignal): Promise<AutoTabRegexResult> {
  if (!pattern.trim() || pattern.length > 300 || url.length > 16_384) return {matches: false, error: 'invalid'};
  if (signal?.aborted) return {matches: false, error: 'unavailable'};
  return new Promise(resolve => {
    let worker: Worker | undefined, timer: ReturnType<typeof setTimeout>, finished = false;
    const finish = (result: AutoTabRegexResult) => {
      if (finished) return;
      finished = true; clearTimeout(timer); worker?.terminate(); signal?.removeEventListener('abort', abort); resolve(result);
    };
    const abort = () => finish({matches: false, error: 'unavailable'});
    try {
      worker = new RegexWorker();
      signal?.addEventListener('abort', abort, {once: true});
      timer = setTimeout(() => finish({matches: false, error: 'unavailable'}), 3000);
      worker.onerror = () => finish({matches: false, error: 'unavailable'});
      worker.onmessage = ({data}) => {
        if (data.ready) {
          clearTimeout(timer);
          timer = setTimeout(() => finish({matches: false, error: 'timeout'}), 100);
          worker!.postMessage({pattern, url});
        } else finish(data);
      };
    } catch { finish({matches: false, error: 'unavailable'}); }
  });
}

export async function runAutoTabRegex(pattern:string,url:string,signal?:AbortSignal):Promise<AutoTabRegexResult>{
  try{
    const run=()=>evaluateRegex(pattern,url,signal);
    return typeof navigator!=='undefined'&&navigator.locks
      ?await navigator.locks.request('nc-auto-tab-regex',signal?{signal}:{},run):await run();
  }catch{return {matches:false,error:'unavailable'};}
}
