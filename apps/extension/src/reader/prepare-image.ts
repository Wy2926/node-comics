/** Predecode when possible; Chromium may reject valid images when its decode cache is full. */
export function prepareReaderImage(url:string,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const image=new Image();let settled=false,loaded=false,fallback=false;
    const invalid=()=>new DOMException('The source image cannot be decoded.','EncodingError');
    const valid=()=>image.naturalWidth>0&&image.naturalHeight>0;
    const finish=(error?:unknown)=>{
      if(settled)return;settled=true;
      image.removeEventListener('load',onLoad);image.removeEventListener('error',onError);signal.removeEventListener('abort',onAbort);
      if(error!==undefined)reject(error);else resolve();
    };
    const onLoad=()=>{loaded=true;if(fallback)finish(valid()?undefined:invalid());};
    const onError=()=>finish(invalid());
    const onAbort=()=>{finish(signal.reason);image.removeAttribute('src');};
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
