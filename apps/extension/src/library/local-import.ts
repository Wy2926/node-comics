import {openComic,prepareComicPage,isComicFile,importedFileHash} from '../importers/comic';
import {imageIdentity,hashFile} from '../importers/hash';
import {emptyPage,naturalSort} from '../reader/model';
import {makeCopy} from './model';
import {putBlob,getBlob,cacheSize,collectUnusedBlobs} from './store';
import type {Page,ReadingCopy} from '../types';
export interface LocalImportProgress {label:string;done?:number;total?:number;}
export async function readLocalFiles(files:File[],limitMb:number,progress:(text:string)=>void,onProgress?:(value:LocalImportProgress)=>void,fileHashes?:WeakMap<File,string>):Promise<ReadingCopy[]>{
 const report=(label:string,done?:number,total?:number)=>{progress(label);onProgress?.({label,done,total});};
 const comics=files.filter(f=>isComicFile(f.name)),images=naturalSort(files.filter(f=>['image/png','image/jpeg','image/webp'].includes(f.type)));
 if(comics.length+images.length!==files.length)throw Error('包含不支持的文件。请选择图片、MOBI、CBZ/ZIP、CBR/RAR 或 PDF。');
 const saved:string[]=[];
 const save=async(blob:Blob,page:Page)=>{const key='original:'+page.imageSha256;if(!await getBlob(key)){if(await cacheSize()+blob.size>limitMb*1024*1024)throw Error('本地空间预算不足，请提高缓存上限后重试。');await putBlob(key,blob);saved.push(key);}page.blobKey=key;};
 const copies:ReadingCopy[]=[];
 try{
 for(const file of naturalSort(comics)){
  report('正在读取漫画文件…');
  const imported=await openComic(file,(done,total)=>report('正在读取文件 · '+Math.round(done/total*100)+'%',done,total),fileHashes?.get(file));const pages:Page[]=[];
  report('正在解析第 1 页',0,imported.total);
  try{for await(const item of imported.pages){report('正在保存第 '+(pages.length+1)+' / '+imported.total+' 页',pages.length,imported.total);const {blob,width,height,imageSha256}=await prepareComicPage(item);const page={...emptyPage(item.name,width,height),fileHash:importedFileHash(imported,imageSha256),pageIndex:item.pageIndex,imageSha256};await save(blob,page);pages.push(page);report('已保存 '+pages.length+' / '+imported.total+' 页',pages.length,imported.total);}pages.sort((a,b)=>a.pageIndex!-b.pageIndex!);if(!pages.length)throw Error('文件中未找到可读漫画页。');const sourceKey=imported.format==='PDF'?'pdf:'+imported.fileHash+':'+await hashFile(new Blob([JSON.stringify(pages.map(p=>p.imageSha256))])):'file:'+imported.fileHash;copies.push(makeCopy(imported.title,pages,imported.format+' 本地导入',sourceKey));}finally{await imported.close();}
 }
 if(images.length){const pages:Page[]=[];for(const file of images){report('正在保存图片 '+(pages.length+1)+' / '+images.length,pages.length,images.length);if(file.size>40*1024*1024)throw Error('单图超过 40 MB 限制。');const bitmap=await createImageBitmap(file);const width=bitmap.width,height=bitmap.height;bitmap.close();if(width*height>100000000)throw Error('图片像素超过本地限制。');const page={...emptyPage(file.name,width,height),...await imageIdentity(file)};await save(file,page);pages.push(page);report('已保存 '+pages.length+' / '+images.length+' 页',pages.length,images.length);}const key=await hashFile(new Blob([JSON.stringify(pages.map(p=>p.imageSha256))]));copies.push(makeCopy(images[0].name.replace(/\.[^.]+$/,''),pages,'本地图片','images:'+key));}
 return copies;
 }catch(e){await collectUnusedBlobs(saved);throw e;}
}
