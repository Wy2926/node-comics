import {msg} from '../../i18n/runtime';

const app = 'net.nodelane.comics.safari.NodeLaneSafari';
const limit = 32 * 1024 * 1024, chunkSize = 512 * 1024;
const invalid = () => Error(msg('图片网络请求失败，请检查连接或刷新来源页面后重试。'));
let nextSlot = 0;

/** Two cross-page slots bound downloads and IPC. This path is explicitly selected
 * by adapters for public source GETs; it never imports browser cookies or credentials. */
export async function withSafariPublicResponse<T>(url:string, headers:Readonly<Record<string,string>>, signal:AbortSignal,
  read:(response:Response)=>Promise<T>,kind:'image'|'text'='image'):Promise<T> {
  if(Object.keys(headers).some(key=>key.toLowerCase()!=='referer'))throw invalid();
  const run=()=>transfer(url,headers.referer??'',signal,read,kind);
  for(let slot=0;slot<2;slot++) {
    let acquired=false;
    const result=await navigator.locks.request('nc-safari-source-'+slot,{ifAvailable:true},lock=>{
      if(!lock)return;
      acquired=true;signal.throwIfAborted();return run();
    });
    if(acquired)return result as T;
  }
  return navigator.locks.request('nc-safari-source-'+(nextSlot++%2),{signal},run);
}

async function transfer<T>(url:string,referer:string,signal:AbortSignal,read:(response:Response)=>Promise<T>,kind:'image'|'text'='image'):Promise<T> {
  signal.throwIfAborted();
  const id=crypto.randomUUID();
  const close=async()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([
      chrome.runtime.sendNativeMessage(app,{type:'source-read-close',id}),
      new Promise(resolve=>{timer=setTimeout(resolve,1500);}),
    ]);}catch{}finally{clearTimeout(timer);}
  };
  const call=async(type:string,fields:Record<string,unknown>={})=>{
    signal.throwIfAborted();
    const pending=chrome.runtime.sendNativeMessage(app,{type,id,...fields});
    // A late open reply must not leave a file when cancellation raced startup.
    void pending.then(()=>{if(signal.aborted)void close();},()=>{});
    return new Promise<any>((resolve,reject)=>{
      const abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      pending.then(resolve,()=>reject(invalid())).finally(()=>signal.removeEventListener('abort',abort));
    });
  };
  const abort=()=>{void close();};signal.addEventListener('abort',abort,{once:true});
  try {
    const meta=await call('source-read-open',{url,referer,kind});
    signal.throwIfAborted();
    if(!meta||!Number.isInteger(meta.status)||meta.status<200||meta.status>599||
      !Number.isInteger(meta.length)||meta.length<0||meta.length>(kind==='text'?8*1024*1024:limit)||!meta.headers||typeof meta.headers!=='object')throw invalid();
    const responseHeaders=new Headers();
    for(const [name,value] of Object.entries(meta.headers)) {
      if(!['content-type','location','cf-mitigated','retry-after'].includes(name)||typeof value!=='string'||value.length>16384)throw invalid();
      responseHeaders.set(name,value);
    }
    let offset=0;
    const body=meta.length?new ReadableStream<Uint8Array<ArrayBuffer>>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const reply=await call('source-read-read',{offset});
          const expected=Math.min(chunkSize,meta.length-offset);
          if(typeof reply?.data!=='string'||reply.data.length!==Math.ceil(expected/3)*4||!(/^[A-Za-z0-9+/]*={0,2}$/).test(reply.data))throw invalid();
          const binary=atob(reply.data);
          if(binary.length!==expected)throw invalid();
          const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
          signal.throwIfAborted();offset+=bytes.length;controller.enqueue(bytes);
          if(offset===meta.length)controller.close();
        }catch(error){controller.error(error);}
      },cancel:close,
    },{highWaterMark:0}):kind==='text'&&meta.status===200?new Uint8Array(0):null;
    return await read(new Response(body,{status:meta.status,headers:responseHeaders}));
  } finally {signal.removeEventListener('abort',abort);await close();}
}
