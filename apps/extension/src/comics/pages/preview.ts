import type {SourceImageProgress} from '../../sources';

/** A frame is borrowed for a synchronous canvas draw, never retained by the consumer. */
export interface PagePreviewTarget {active():boolean;draw(frame:VideoFrame):void;clear():void;}
type Session={decoder:ImageDecoder;input:ReadableStreamDefaultController<Uint8Array>;cursor:number;ended:boolean;timer?:ReturnType<typeof setTimeout>;wake?:()=>void};

/** One native incremental decoder per shared source read. It never owns or restarts the download. */
export class PagePreview {
  private targets=new Set<PagePreviewTarget>();
  private progress?:SourceImageProgress;
  private session?:Session;
  private frame?:VideoFrame;
  private failed?:SourceImageProgress['chunks'];
  private finished=false;

  add(target:PagePreviewTarget){
    if(this.finished)return ()=>{};
    this.targets.add(target);
    if(this.frame&&target.active())this.draw(target,this.frame);
    this.refresh();
    return ()=>{this.targets.delete(target);this.refresh();};
  }
  feed=(progress:SourceImageProgress|undefined)=>{
    if(this.finished)return;
    if(!progress){this.stop(true);this.progress=undefined;this.failed=undefined;return;}
    if(this.progress&&this.progress.chunks!==progress.chunks)this.stop(true);
    this.progress=progress;this.refresh();
  };
  refresh(){
    if(this.finished)return;
    if(!this.activeTargets().length){this.stop(false);return;}
    const progress=this.progress;
    if(!progress||this.failed===progress.chunks||typeof ImageDecoder==='undefined')return;
    if(!this.session){
      // Completed/cache reads go straight to final display; previews only shorten network waits.
      if(progress.done)return;
      const type=imageType(progress.chunks);if(!type)return;
      try{
        let input!:Session['input'];
        const data=new ReadableStream<Uint8Array>({start(controller){input=controller;}});
        const decoder=new ImageDecoder({data,type,preferAnimation:false});
        void decoder.completed.catch(()=>{});
        this.session={decoder,input,cursor:0,ended:false};
        void this.decode(this.session);
      }catch{this.failed=progress.chunks;return;}
    }
    const session=this.session;
    if(!session.ended)try{
      while(session.cursor<progress.chunks.length)session.input.enqueue(progress.chunks[session.cursor++]);
      if(progress.done){session.input.close();session.ended=true;}
    }catch{this.failed=progress.chunks;this.stop(false);}
  }
  /** Leave painted pixels until the real display loads; a failed final validation removes them. */
  finish(failed=false){this.finished=true;this.stop(failed);this.progress=undefined;this.failed=undefined;this.targets.clear();}
  private activeTargets(){return [...this.targets].filter(target=>{try{return target.active();}catch{return false;}});}
  private draw(target:PagePreviewTarget,frame:VideoFrame){try{target.draw(frame);}catch{/* A detached canvas must not affect other readers. */}}
  private async decode(session:Session){
    try{
      while(this.session===session){
        const {image,complete}=await session.decoder.decode({completeFramesOnly:false});
        if(this.session!==session){image.close();return;}
        this.frame?.close();this.frame=image;
        for(const target of this.activeTargets())this.draw(target,image);
        if(complete)return;
        // First pixels are immediate. Later refinements share the decoder without flooding canvas paints.
        await new Promise<void>(resolve=>{session.wake=resolve;session.timer=setTimeout(resolve,100);});
        session.timer=undefined;session.wake=undefined;
        this.refresh();
      }
    }catch{if(this.session===session){this.failed=this.progress?.chunks;this.stop(false);}}
  }
  private stop(clear:boolean){
    const session=this.session;this.session=undefined;
    if(session){clearTimeout(session.timer);session.wake?.();session.decoder.close();}
    this.frame?.close();this.frame=undefined;
    if(clear)for(const target of this.targets){try{target.clear();}catch{/* A retired reader owns its own cleanup. */}}
  }
}

function imageType(chunks:SourceImageProgress['chunks']){
  const bytes=new Uint8Array(12);let length=0;
  for(const chunk of chunks){const count=Math.min(chunk.length,12-length);bytes.set(chunk.subarray(0,count),length);length+=count;if(length===12)break;}
  if(length<12)return;
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71)return 'image/png';
  if(String.fromCharCode(...bytes.subarray(0,4))==='RIFF'&&String.fromCharCode(...bytes.subarray(8,12))==='WEBP')return 'image/webp';
}
