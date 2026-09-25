import type {ReadingEntry} from '../types';

const identity=(chapter:ReadingEntry)=>JSON.stringify([chapter.id,chapter.contentId??null,chapter.generation]);

/** Keep geometry while renewing source locators before any new window chapter reads bytes. */
export class ChapterResourceWindow {
 private states=new Map<string,{ready:boolean}>();
 constructor(current:ReadingEntry){if(current.pages.length)this.states.set(identity(current),{ready:true});}
 ready(chapter:ReadingEntry){return this.states.get(identity(chapter))?.ready===true;}
 prepare(chapters:ReadingEntry[],load:(id:string)=>void|Promise<void>,changed:()=>void){
  const keep=new Set(chapters.map(identity));
  for(const key of this.states.keys())if(!keep.has(key))this.states.delete(key);
  for(const chapter of chapters){
   const key=identity(chapter);if(this.states.has(key))continue;
   const state={ready:false};this.states.set(key,state);
   // Even a failed refresh releases retained pages for cached reading; the loader reports the failure.
   void Promise.resolve().then(()=>load(chapter.id)).catch(()=>{}).finally(()=>{
    if(this.states.get(key)!==state)return;state.ready=true;changed();
   });
  }
 }
 clear(){this.states.clear();}
}
