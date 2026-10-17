import type {ReadingEntry} from '../types';

const identity=(chapter:ReadingEntry)=>JSON.stringify([chapter.id,chapter.contentId??null,chapter.generation]);
export interface ChapterLoadOptions {signal?:AbortSignal;speculative?:boolean}
type ResourceState={ready:boolean;failed:boolean;foregroundAttempted:boolean;speculative:boolean;controller:AbortController};

/** Keep geometry while renewing source locators before any new window chapter reads bytes. */
export class ChapterResourceWindow {
 private states=new Map<string,ResourceState>();
 constructor(current:ReadingEntry){if(current.pages.length)this.states.set(identity(current),{ready:true,failed:false,foregroundAttempted:true,speculative:false,controller:new AbortController()});}
 ready(chapter:ReadingEntry){return this.states.get(identity(chapter))?.ready===true;}
 prepare(chapters:ReadingEntry[],load:(id:string,options?:ChapterLoadOptions)=>void|Promise<void>,changed:()=>void,speculativeIds:readonly string[]=[]){
  const keep=new Set(chapters.map(identity)),speculative=new Set(speculativeIds);
  for(const [key,state] of this.states)if(!keep.has(key)){state.controller.abort();this.states.delete(key);}
  for(const chapter of chapters){
   const key=identity(chapter),previous=this.states.get(key),background=speculative.has(chapter.id);
   if(previous){
    previous.speculative=background;
    if(!previous.ready&&!background)previous.foregroundAttempted=true;
    if(!previous.failed||background||previous.foregroundAttempted)continue;
    previous.controller.abort();
   }
   const state:ResourceState={ready:previous?.ready??false,failed:false,foregroundAttempted:!background,speculative:background,controller:new AbortController()};
   this.states.set(key,state);
   const options:ChapterLoadOptions={signal:state.controller.signal,get speculative(){return state.speculative;}};
   // Even a failed refresh releases retained pages for cached reading; the loader reports the failure.
   void Promise.resolve().then(()=>{if(!state.controller.signal.aborted)return load(chapter.id,options);}).catch(()=>{state.failed=true;}).finally(()=>{
    if(state.controller.signal.aborted||this.states.get(key)!==state)return;state.ready=true;changed();
   });
  }
 }
 clear(){for(const state of this.states.values())state.controller.abort();this.states.clear();}
}
