import {hashFile} from '../importers/hash';
import {isComicFile,MAX_FILE,MiB} from '../importers/comic-shared';
import {naturalSort} from '../reader/model';
import {readLocalFiles,type LocalImportProgress} from './local-import';
import {readCopies,commitCopies,collectUnusedBlobs,copyBlobKeys} from './store';
import type {ReadingCopy} from '../types';
import type {ImportAssignment} from './types';

export type ImportStatus='checking'|'ready'|'restore'|'duplicate'|'queued'|'importing'|'created'|'restored'|'failed'|'cancelled';
export interface ImportItem {
 id:string;title:string;files:File[];bytes:number;selected:boolean;status:ImportStatus;
 key?:string;copyId?:string;existingTitle?:string;message:string;progress?:LocalImportProgress;
}
export interface ImportSnapshot {items:ImportItem[];checking:boolean;running:boolean;pauseRequested:boolean;phase:'review'|'running'|'paused'|'done';}
const imageFile=(file:File)=>['image/png','image/jpeg','image/webp'].includes(file.type);
export const selectableImport=(item:ImportItem)=>['ready','restore'].includes(item.status);
export const importSummary=(items:ImportItem[])=>{
 const count=(status:ImportStatus)=>items.filter(item=>item.status===status).length;
 const parts=[count('created')&&`新增 ${count('created')} 份`,count('restored')&&`补齐原图 ${count('restored')} 份`,count('duplicate')&&`已有 ${count('duplicate')} 份，已跳过`,count('failed')&&`${count('failed')} 份失败`,count('cancelled')&&`${count('cancelled')} 份已取消`].filter(Boolean);
 return parts.join(' · ')||'选择要加入书架的漫画';
};

/** Local files remain in this tab. Every copy commits separately; IDB still arbitrates cross-tab duplicates. */
export class LocalImportQueue {
 private state:ImportSnapshot={items:[],checking:false,running:false,pauseRequested:false,phase:'review'};
 private listeners=new Set<()=>void>();
 private assignment?:ImportAssignment;
 private assignmentKey='';
 private separateWorks=false;
 private limitMb=512;
 private disposed=false;
 private fileHashes=new WeakMap<File,string>();
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 getSnapshot=()=>this.state;
 private update(patch:Partial<ImportSnapshot>){this.state={...this.state,...patch};this.listeners.forEach(listener=>listener());}
 private patch(id:string,patch:Partial<ImportItem>){this.update({items:this.state.items.map(item=>item.id===id?{...item,...patch}:item)});}
 dispose(){this.disposed=true;this.stopRemaining();}
 activate(){this.disposed=false;}
 async add(files:File[]){
  if(this.state.running||this.state.checking||this.state.phase==='paused')return false;
  const images=naturalSort(files.filter(imageFile));
  const groups=[...naturalSort(files.filter(file=>!imageFile(file))).map(file=>[file]),...(images.length?[images]:[])];
  const added=groups.map(group=>({id:crypto.randomUUID(),title:group[0].name,files:group,bytes:group.reduce((sum,file)=>sum+file.size,0),selected:true,status:'checking' as const,message:'等待检查文件内容'}));
  this.update({items:[...this.state.items,...added],phase:'review',checking:true});
  try{for(const item of added){if(this.disposed)break;await this.inspect(item.id);}}
  finally{this.update({checking:false});}
  return true;
 }
 private async identify(item:ImportItem){
  const hashes:string[]=[];let previousBytes=0;
  for(const file of item.files){
   const comic=isComicFile(file.name);
   if(!comic&&!imageFile(file))throw Error('不支持此文件。请选择 PNG、JPEG、WebP、MOBI、CBZ/ZIP、CBR/RAR 或 PDF。');
   if(!file.size)throw Error('文件为空，请重新选择。');
   if(file.size>(comic?MAX_FILE:40*MiB))throw Error(comic?'文件超过 512 MB，请拆分为章节。':'单图超过 40 MB，请缩小图片。');
   if(/\.(cbr|rar)$/i.test(file.name)&&file.size>128*MiB)throw Error('CBR/RAR 最大支持 128 MB，请拆分或转换为 CBZ/ZIP。');
   const digest=this.fileHashes.get(file)??await hashFile(file,(done)=>{
    if(this.disposed||!this.state.items.some(current=>current.id===item.id))throw Error('检查已停止。');
    this.patch(item.id,{message:'正在检查是否重复',progress:{label:'正在检查文件内容',done:previousBytes+done,total:item.bytes}});
   });
   hashes.push(digest);this.fileHashes.set(file,digest);
   previousBytes+=file.size;
  }
  if(imageFile(item.files[0]))return 'images:'+await hashFile(new Blob([JSON.stringify(hashes)]));
  if(/\.pdf$/i.test(item.files[0].name))return 'pdf:'+await (await import('../importers/pdf')).pdfFileHash(hashes[0]);
  return 'file:'+hashes[0];
 }
 private async existing(key:string){
  const copies=await readCopies();
  const matches=copies.filter(copy=>copy.sourceKey===key||key.startsWith('pdf:')&&copy.sourceKey.startsWith(key+':'));
  return matches.find(copy=>copy.pages.length&&copy.pages.every(page=>page.blobKey))??matches[0];
 }
 private async inspect(id:string){
  const item=this.state.items.find(item=>item.id===id);if(!item)return;
  this.patch(id,{status:'checking',message:'正在检查是否重复',progress:undefined});
  try{
   const key=item.key??await this.identify(item),existing=await this.existing(key);
   if(existing){
    const complete=existing.pages.length>0&&existing.pages.every(page=>page.blobKey);
    this.patch(id,{key,status:complete?'duplicate':'restore',selected:!complete,copyId:existing.id,existingTitle:existing.title,progress:undefined,message:complete?`书架已有《${existing.title}》，原图完整，无需再次导入。`:`《${existing.title}》的本机原图不完整，将补齐原图并保留阅读位置。`});
   }else this.patch(id,{key,status:'ready',copyId:undefined,existingTitle:undefined,message:'待导入',progress:undefined});
  }catch(reason){this.patch(id,{status:'failed',message:reason instanceof Error?reason.message:'检查失败，请重试。',progress:undefined});}
 }
 select(id:string,selected:boolean){if(!this.state.running&&!this.state.checking)this.update({items:this.state.items.map(item=>item.id===id&&selectableImport(item)?{...item,selected}:item)});}
 selectAll(selected:boolean){if(!this.state.running&&!this.state.checking)this.update({items:this.state.items.map(item=>selectableImport(item)?{...item,selected}:item)});}
 remove(id:string){
  const item=this.state.items.find(item=>item.id===id);
  if(!item||item.status==='importing')return;
  const items=this.state.items.filter(item=>item.id!==id);
  if(!items.length&&!this.state.running){this.assignment=undefined;this.assignmentKey='';this.update({items,phase:'review'});}
  else this.update({items});
 }
 clear(){if(!this.state.running&&!this.state.checking&&this.state.phase!=='paused'){this.assignment=undefined;this.assignmentKey='';this.update({items:[],phase:'review'});}}
 async recheck(ids:string[]){
  if(this.state.running||this.state.checking||this.state.phase==='paused')return;
  this.update({checking:true,phase:'review'});
  try{for(const id of ids){if(this.disposed)break;await this.inspect(id);}}
  finally{this.update({checking:false});}
 }
 async start(assignment:ImportAssignment,limitMb:number,separateWorks=false){
  if(this.state.running||this.state.checking||this.disposed)return;
  if(!assignment.workId&&!assignment.title.trim()&&!separateWorks)return;
  if(!this.state.items.some(item=>item.selected&&selectableImport(item)))return;
  const key=JSON.stringify([assignment,separateWorks]);
  if(key!==this.assignmentKey){this.assignment={...assignment};this.assignmentKey=key;}
  this.separateWorks=separateWorks;this.limitMb=limitMb;
  this.update({items:this.state.items.map(item=>item.selected&&selectableImport(item)?{...item,status:'queued',message:'等待导入'}:item),pauseRequested:false});
  await this.run();
 }
 async retry(ids:string[],assignment:ImportAssignment,limitMb:number,separateWorks=false){
  if(this.state.running||this.state.checking||this.state.phase==='paused')return;
  await this.recheck(ids);
  if(!this.assignment){this.assignment={...assignment};this.assignmentKey=JSON.stringify([assignment,separateWorks]);}
  this.limitMb=limitMb;
  if(!this.state.items.some(item=>['created','restored'].includes(item.status)))this.separateWorks=separateWorks;
  this.update({items:this.state.items.map(item=>ids.includes(item.id)&&selectableImport(item)?{...item,status:'queued',message:'等待重试'}:item)});
  await this.run();
 }
 pause(){if(this.state.running)this.update({pauseRequested:true});}
 async resume(){if(this.state.running||this.state.phase!=='paused'||this.disposed)return;this.update({pauseRequested:false});await this.run();}
 stopRemaining(){
  this.update({pauseRequested:false,items:this.state.items.map(item=>item.status==='queued'?{...item,status:'cancelled',message:'已取消，尚未导入；已完成的漫画保留在书架。'}:item),...(!this.state.running&&this.state.phase==='paused'?{phase:'done' as const}:{})});
 }
 private async run(){
  this.update({running:true,phase:'running'});
  try{
   while(!this.disposed&&!this.state.pauseRequested){
    const item=this.state.items.find(item=>item.status==='queued');if(!item)break;
    this.patch(item.id,{status:'importing',message:'正在核对书架',progress:undefined});
    let incoming:ReadingCopy[]=[];
    try{
     // Repeat the cheap lookup immediately before extraction: another item/tab may have just imported it.
     const existing=item.key?await this.existing(item.key):undefined;
     if(existing?.pages.length&&existing.pages.every(page=>page.blobKey)){
      this.patch(item.id,{status:'duplicate',copyId:existing.id,existingTitle:existing.title,message:`书架已有《${existing.title}》，已跳过，无需再次导入。`});continue;
     }
     incoming=await readLocalFiles(item.files,this.limitMb,()=>{},progress=>this.patch(item.id,{message:progress.label,progress}),this.fileHashes);
     if(this.disposed)throw Error('导入页面已关闭。');
     this.patch(item.id,{message:'正在加入书架',progress:undefined});
     const assignment=this.separateWorks?{...this.assignment!,workId:undefined,title:incoming[0].title}:this.assignment!;
     const result=await commitCopies(incoming,incoming.map(()=>assignment));
     if(!this.separateWorks&&!this.assignment!.workId&&result.workIds[0])this.assignment={...this.assignment!,workId:result.workIds[0]};
     const saved=(await readCopies()).find(copy=>copy.id===result.copyIds[0]);
     if(!saved)throw Error('导入结果已被移除，请重新检查书架。');
     const missing=saved.pages.filter(page=>!page.blobKey).length;
     if(missing)throw Error(`这份副本仍有 ${missing} 页缺少原图。页面可能经过增删或来自其他文件，请补充对应原图；已有内容和阅读位置已保留。`);
     const status=result.created?'created':existing?'restored':'duplicate';
     this.patch(item.id,{status,copyId:result.copyIds[0],message:status==='created'?`已加入书架 · ${incoming[0].pages.length} 页`:status==='restored'?'原图已补齐，原归属、译图记录和阅读位置已保留。':'此内容已加入书架，已跳过重复创建。',progress:undefined});
    }catch(reason){this.patch(item.id,{status:'failed',message:reason instanceof Error?reason.message:'导入失败，请重试。',progress:undefined});}
    finally{await collectUnusedBlobs(incoming.flatMap(copyBlobKeys)).catch(()=>{});}
   }
  }finally{this.update({running:false,phase:this.state.items.some(item=>item.status==='queued')?'paused':'done',pauseRequested:false});}
 }
}
