import {openComic,prepareComicPage,isComicFile,importedFileHash} from '../importers/comic';
import {imageIdentity,hashFile} from '../importers/hash';
import {emptyPage,naturalSort} from '../reader/model';
import {makeCopy} from './model';
import {putBlob,getBlob,cacheSize,collectUnusedBlobs} from './store';
import type {Page,ReadingCopy} from '../types';
export async function readLocalFiles(files:File[],limitMb:number,progress:(text:string)=>void):Promise<ReadingCopy[]>{
 const comics=files.filter(f=>isComicFile(f.name)),images=naturalSort(files.filter(f=>['image/png','image/jpeg','image/webp'].includes(f.type)));
 if(comics.length+images.length!==files.length)throw Error('包含不支持的文件。请选择图片、MOBI、CBZ/ZIP、CBR/RAR 或 PDF。');
 const saved:string[]=[];
 const save=async(blob:Blob,page:Page)=>{const key='original:'+page.imageSha256;if(!await getBlob(key)){if(await cacheSize()+blob.size>limitMb*1024*1024)throw Error('本地空间预算不足，请提高缓存上限后重试。');await putBlob(key,blob);saved.push(key);}page.blobKey=key;};
 const copies:ReadingCopy[]=[];
 try{
 for(const file of naturalSort(comics)){
  const imported=await openComic(file);const pages:Page[]=[];
  try{for await(const item of imported.pages){progress(file.name+' · '+(pages.length+1)+' / '+imported.total+' 页');const {blob,width,height,imageSha256}=await prepareComicPage(item);const page={...emptyPage(item.name,width,height),fileHash:importedFileHash(imported,imageSha256),pageIndex:item.pageIndex,imageSha256};await save(blob,page);pages.push(page);}pages.sort((a,b)=>a.pageIndex!-b.pageIndex!);if(!pages.length)throw Error('文件中未找到可读漫画页。');const sourceKey=imported.format==='PDF'?'pdf:'+imported.fileHash+':'+await hashFile(new Blob([JSON.stringify(pages.map(p=>p.imageSha256))])):'file:'+imported.fileHash;copies.push(makeCopy(imported.title,pages,imported.format+' 本地导入',sourceKey));}finally{await imported.close();}
 }
 if(images.length){const pages:Page[]=[];for(const file of images){progress('正在保存图片 '+(pages.length+1)+' / '+images.length);if(file.size>40*1024*1024)throw Error('单图超过 40 MB 限制。');const bitmap=await createImageBitmap(file);const width=bitmap.width,height=bitmap.height;bitmap.close();if(width*height>100000000)throw Error('图片像素超过本地限制。');const page={...emptyPage(file.name,width,height),...await imageIdentity(file)};await save(file,page);pages.push(page);}const key=await hashFile(new Blob([JSON.stringify(pages.map(p=>p.imageSha256))]));copies.push(makeCopy(images[0].name.replace(/\.[^.]+$/,''),pages,'本地图片','images:'+key));}
 return copies;
 }catch(e){await collectUnusedBlobs(saved);throw e;}
}
