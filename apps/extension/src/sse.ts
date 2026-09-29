/** UTF-8 SSE framing; comments are heartbeats, not application updates. */
export async function* serverEvents(body:ReadableStream<Uint8Array>,signal:AbortSignal,idleMs=45_000){
  const reader=body.getReader(),decoder=new TextDecoder();
  let buffer='',event='',data:string[]=[],dataLength=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  try{
    for(;;){
      signal.throwIfAborted();
      let idle=false;const timer=setTimeout(()=>{idle=true;cancel();},idleMs);
      let chunk:ReadableStreamReadResult<Uint8Array>;
      try{chunk=await reader.read();}finally{clearTimeout(timer);}
      signal.throwIfAborted();if(idle)throw Error('SSE stream idle');
      if(chunk.done)return;
      buffer+=decoder.decode(chunk.value,{stream:true});
      if(buffer.length>1024*1024)throw Error('SSE frame too large');
      for(;;){
        const end=buffer.search(/[\r\n]/);if(end<0||buffer[end]==='\r'&&end===buffer.length-1)break;
        const line=buffer.slice(0,end);buffer=buffer.slice(end+(buffer[end]==='\r'&&buffer[end+1]==='\n'?2:1));
        if(!line){if(data.length)yield {event:event||'message',data:data.join('\n')};event='';data=[];dataLength=0;continue;}
        const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon),value=colon<0?'':line.slice(colon+1).replace(/^ /,'');
        if(field==='event')event=value;else if(field==='data'){data.push(value);dataLength+=value.length+1;}
        if(dataLength>1024*1024)throw Error('SSE frame too large');
      }
    }
  }finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
