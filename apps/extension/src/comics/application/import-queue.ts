import {msg,englishDictionary,type MessageKey} from '../../i18n/runtime';
import { importLocalFile, importImageAlbum } from './import-service';
import type { ImportAssignment } from './types';
import { catalog } from '../repositories';
import { detectFormat } from '../formats/identify';

export type ImportStatus='checking'|'ready'|'duplicate'|'queued'|'importing'|'created'|'failed'|'cancelled';
export interface ImportItem {id:string;title:string;files:File[];bytes:number;selected:boolean;status:ImportStatus;key?:string;copyId?:string;existingTitle?:string;message:string;progress?:{label:string;done?:number;total?:number};}
export interface ImportSnapshot {items:ImportItem[];checking:boolean;running:boolean;pauseRequested:boolean;phase:'review'|'running'|'paused'|'done';}
export const selectableImport=(item:ImportItem)=>item.status==='ready';
export const importSummary=(items:ImportItem[])=>msg('{0} 份已导入 · {1} 份需要处理',{'0':items.filter(i=>i.status==='created').length,'1':items.filter(i=>i.status==='failed').length});
export class LocalImportQueue {
  private state:ImportSnapshot={items:[],checking:false,running:false,pauseRequested:false,phase:'review'};
  private listeners=new Set<()=>void>();private disposed=false;private controller?:AbortController;
  private assignment?:ImportAssignment;private separate=false;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  getSnapshot=()=>this.state;
  private update(value:Partial<ImportSnapshot>){this.state={...this.state,...value};for(const fn of this.listeners)fn();}
  private patch(id:string,value:Partial<ImportItem>){this.update({items:this.state.items.map(i=>i.id===id?{...i,...value}:i)});}
  activate(){this.disposed=false;}
  dispose(){this.disposed=true;this.controller?.abort();this.stopRemaining();}
  async add(files:File[]){
    if(this.state.running||this.state.checking||this.state.phase==='paused')return false;
    const ordered=[...files].sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));
    const images=ordered.filter(f=>/^image\//.test(f.type)||/\.(png|jpe?g|webp|gif)$/i.test(f.name));
    const groups=[...ordered.filter(f=>!images.includes(f)).map(f=>[f]),...(images.length?[images]:[])];
    const items=groups.map(files=>({id:crypto.randomUUID(),title:files[0].name,files,bytes:files.reduce((n,f)=>n+f.size,0),selected:true,status:'checking' as const,message:msg("正在检查文件类型")}));
    this.update({items:[...this.state.items,...items],checking:true,phase:'review'});
    try{for(const item of items)await this.inspect(item.id);}finally{this.update({checking:false});}return true;
  }
  private async inspect(id:string){
    const item=this.state.items.find(i=>i.id===id);if(!item)return;
    try{for(const file of item.files){if(!file.size||file.size>512*1024*1024)throw Error(msg("源文件为空或超过 512 MB。"));if(!detectFormat(file.name,new Uint8Array(await file.slice(0,80).arrayBuffer())))throw Error(msg("不支持的漫画格式或文件签名。"));}
      this.patch(id,{status:'ready',message:msg("完整源文件保存时计算摘要并去重；不预先展开图片。"),progress:undefined});
    }catch(error){this.patch(id,{status:'failed',message:(error as Error).message});}
  }
  select(id:string,selected:boolean){if(!this.state.running)this.patch(id,{selected});}
  selectAll(selected:boolean){if(!this.state.running)this.update({items:this.state.items.map(i=>selectableImport(i)?{...i,selected}:i)});}
  remove(id:string){if(!this.state.running)this.update({items:this.state.items.filter(i=>i.id!==id)});}
  clear(){if(!this.state.running)this.update({items:[],phase:'review'});}
  async start(assignment:ImportAssignment,_limitMb:number,separate=false){if(this.disposed||this.state.running)return;this.assignment={...assignment};this.separate=separate;this.update({items:this.state.items.map(i=>i.selected&&selectableImport(i)?{...i,status:'queued'}:i)});await this.run();}
  async retry(ids:string[],assignment:ImportAssignment,limitMb:number,separate=false){for(const id of ids)await this.inspect(id);await this.start(assignment,limitMb,separate);}
  pause(){this.update({pauseRequested:true});}
  async resume(){if(!this.state.running){this.update({pauseRequested:false});await this.run();}}
  stopRemaining(){this.update({items:this.state.items.map(i=>i.status==='queued'?{...i,status:'cancelled',message:msg("已停止，尚未保存的文件需要重新选择。")}:i),pauseRequested:false,phase:'done'});}
  cancelCurrent(){this.controller?.abort(new DOMException(msg("导入已取消；已保存的源文件可重试索引。"),'AbortError'));}
  private async run(){
    this.update({running:true,phase:'running'});
    try{while(!this.disposed&&!this.state.pauseRequested){
      const item=this.state.items.find(i=>i.status==='queued');if(!item)break;
      this.controller=new AbortController();this.patch(item.id,{status:'importing',message:msg("正在保存源文件")});
      try{
        const assignment=this.separate?{...this.assignment!,workId:undefined,unitId:undefined,title:item.title.replace(/\.[^.]+$/,'')}:this.assignment!;
        const progress=(label:string,done?:number,total?:number)=>{const localized=Object.hasOwn(englishDictionary,label)?msg(label as MessageKey):label;this.patch(item.id,{message:localized,progress:{label:localized,done,total}});};
        const result=item.files.length>1?await importImageAlbum(item.files,assignment,this.controller.signal,progress):await importLocalFile(item.files[0],assignment,this.controller.signal,progress);
        this.patch(item.id,{status:result.created?'created':'duplicate',copyId:result.id,message:result.created?msg("源文件已保存，目录已就绪，可以阅读。"):msg("相同内容已存在，完整源文件已共享。"),progress:undefined});
        if(!this.separate&&!this.assignment!.workId){const doc=await catalog.get('documents',result.id),unit=doc&&await catalog.get('units',doc.unitId);this.assignment={...this.assignment!,workId:unit?.workId};}
      }catch(error){this.patch(item.id,{status:'failed',message:(error as Error).message,progress:undefined});}
    }}finally{this.update({running:false,phase:this.state.items.some(i=>i.status==='queued')?'paused':'done',pauseRequested:false});}
  }
}
