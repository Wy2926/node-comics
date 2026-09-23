import {msg,englishDictionary,type MessageKey} from '../../i18n/runtime';
import {importLocalFile} from './import-service';

export type ImportStatus='queued'|'importing'|'created'|'duplicate'|'failed'|'cancelled';
export interface ImportItem {id:string;title:string;file:File;bytes:number;status:ImportStatus;entryId?:string;message:string;progress?:{done?:number;total?:number};}
export interface ImportSnapshot {items:ImportItem[];running:boolean;pauseRequested:boolean;phase:'idle'|'running'|'paused'|'done';}
export const importSummary=(items:ImportItem[])=>msg('{0} 份已导入 · {1} 份需要处理',{'0':items.filter(i=>i.status==='created'||i.status==='duplicate').length,'1':items.filter(i=>i.status==='failed').length});
/** Picking files is the only import decision. Each file owns an independent comic. */
export class LocalImportQueue {
 private state:ImportSnapshot={items:[],running:false,pauseRequested:false,phase:'idle'};
 private listeners=new Set<()=>void>();private disposed=false;private controller?:AbortController;
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 getSnapshot=()=>this.state;
 private update(value:Partial<ImportSnapshot>){this.state={...this.state,...value};for(const fn of this.listeners)fn();}
 private patch(id:string,value:Partial<ImportItem>){this.update({items:this.state.items.map(i=>i.id===id?{...i,...value}:i)});}
 activate(){this.disposed=false;}
 dispose(){this.disposed=true;this.controller?.abort();this.stopRemaining();}
 async add(files:File[]):Promise<ImportItem[]>{
  if(this.disposed||this.state.running||this.state.phase==='paused')return [];
  const items=files.map(file=>({id:crypto.randomUUID(),title:file.name,file,bytes:file.size,status:'queued' as const,message:msg('等待导入')}));
  this.update({items:[...this.state.items,...items]});await this.run();
  const ids=new Set<string>(items.map(item=>item.id));return this.state.items.filter(item=>ids.has(item.id));
 }
 clear(){if(!this.state.running&&this.state.phase!=='paused')this.update({items:[],phase:'idle'});}
 async retry(ids:string[]){if(this.state.running||this.state.phase==='paused')return;const selected=new Set(ids);this.update({items:this.state.items.map(i=>selected.has(i.id)&&['failed','cancelled'].includes(i.status)?{...i,status:'queued',message:msg('等待导入')}:i)});await this.run();}
 pause(){if(this.state.running)this.update({pauseRequested:true});}
 async resume(){if(!this.state.running){this.update({pauseRequested:false});await this.run();}}
 stopRemaining(){this.update({items:this.state.items.map(i=>i.status==='queued'?{...i,status:'cancelled',message:msg('已取消')}:i),pauseRequested:false,...(!this.state.running?{phase:'done' as const}:{})});}
 cancelCurrent(){this.controller?.abort(new DOMException(msg('已取消'),'AbortError'));}
 private async run(){
  this.update({running:true,phase:'running'});
  try{while(!this.disposed&&!this.state.pauseRequested){
   const item=this.state.items.find(i=>i.status==='queued');if(!item)break;
   this.controller=new AbortController();this.patch(item.id,{status:'importing',message:msg('正在保存源文件')});
   try{
    const progress=(label:string,done?:number,total?:number)=>this.patch(item.id,{message:Object.hasOwn(englishDictionary,label)?msg(label as MessageKey):label,progress:{done,total}});
    const result=await importLocalFile(item.file,this.controller.signal,progress);
    this.patch(item.id,{status:result.created?'created':'duplicate',entryId:result.id,message:result.created?msg('可以开始阅读'):msg('已存在，继续阅读'),progress:undefined});
   }catch(error){this.patch(item.id,{status:this.controller.signal.aborted?'cancelled':'failed',message:(error as Error).message,progress:undefined});}
   finally{this.controller=undefined;}
  }}finally{this.update({running:false,phase:this.state.items.some(i=>i.status==='queued')?'paused':'done',pauseRequested:false});}
 }
}
