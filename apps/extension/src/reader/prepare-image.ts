import {msg} from '../i18n/runtime';

type Priority='current'|'prefetch';
type Preparation={priority:Priority;start():void;cancel():void};
const preparations=new Map<string,Preparation>();
const queued:Preparation[]=[];
const running=new Set<Preparation>();
function drain(){
  while(running.size<2){
    let index=queued.findIndex(task=>task.priority==='current');
    // Leave capacity for a newly visible page, even when cached neighbors arrive together.
    if(index<0&&![...running].some(task=>task.priority==='prefetch'))index=0;
    if(index<0||!queued[index])return;
    const task=queued.splice(index,1)[0];running.add(task);task.start();
  }
}
/** Update the same task when scrolling changes which page is current. */
export function setReaderImagePriority(url:string,priority:Priority){
  const task=preparations.get(url);
  if(task&&task.priority!==priority){task.priority=priority;drain();}
}
/** At most two native preparations, including at most one speculative neighbor. */
export function prepareReaderImage(url:string,signal:AbortSignal,priority:Priority='current'):Promise<void>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const finish=(error?:unknown)=>{
      signal.removeEventListener('abort',task.cancel);
      if(preparations.get(url)===task)preparations.delete(url);
      running.delete(task);
      const index=queued.indexOf(task);if(index>=0)queued.splice(index,1);
      if(error!==undefined)reject(error);else resolve();
      drain();
    };
    const task:Preparation={priority,
      start(){signal.removeEventListener('abort',task.cancel);try{void decodeReaderImage(url,signal).then(()=>finish(),finish);}catch(error){finish(error);}},
      cancel(){finish(signal.reason);},
    };
    preparations.set(url,task);queued.push(task);signal.addEventListener('abort',task.cancel,{once:true});drain();
  });
}

/** Predecode when possible; Chromium may reject valid images when its decode cache is full. */
function decodeReaderImage(url:string,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const image=new Image();let settled=false,loaded=false,fallback=false;
    const invalid=()=>new DOMException('The source image cannot be decoded.','EncodingError');
    const valid=()=>image.naturalWidth>0&&image.naturalHeight>0;
    const finish=(error?:unknown)=>{
      if(settled)return;settled=true;
      clearTimeout(timer);image.removeEventListener('load',onLoad);image.removeEventListener('error',onError);signal.removeEventListener('abort',onAbort);
      if(error!==undefined)reject(error);else resolve();
    };
    const onLoad=()=>{loaded=true;if(fallback)finish(valid()?undefined:invalid());};
    const onError=()=>finish(invalid());
    const onAbort=()=>{finish(signal.reason);image.removeAttribute('src');};
    const timer=setTimeout(()=>{finish(Error(msg('图片解码超时，请重试。')));image.removeAttribute('src');},120000);
    // Loading can finish before decode rejects, so install these before assigning src.
    image.addEventListener('load',onLoad);image.addEventListener('error',onError);signal.addEventListener('abort',onAbort,{once:true});
    image.src=url;
    try{
      void image.decode().then(()=>finish(valid()?undefined:invalid()),(error:unknown)=>{
        if(settled)return;
        if((error as {name?:string})?.name!=='EncodingError'){finish(error);return;}
        fallback=true;
        if(loaded||image.complete)finish(valid()?undefined:error);
      });
    }catch(error){finish(error);}
  });
}
