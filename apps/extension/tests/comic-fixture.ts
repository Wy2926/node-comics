import {BlobReader,BlobWriter,ZipWriter} from '@zip.js/zip.js/index-native.js';
import {catalog} from '../src/comics/repositories';
import type {Comic,Entry,PageDescriptor} from '../src/comics/domain';

export async function comicFile(name:string,pages:Blob[]):Promise<File>{
 const writer=new ZipWriter(new BlobWriter(),{useWebWorkers:false,level:0});
 for(const [index,page] of pages.entries())await writer.add(String(index+1).padStart(4,'0')+'.png',new BlobReader(page));
 return new File([await writer.close()],name+'.cbz',{type:'application/zip'});
}
export async function seedComic(options:Partial<Entry>={}){
 const id=options.id??crypto.randomUUID(),comicId=options.comicId??id+':comic',contentId=options.contentId??id+':content';
 const comic:Comic={id:comicId,title:'Test comic',sourceName:'Local',sourceKey:id,source:{connectionId:'local',providerItemId:id,locator:{},status:'active',generation:1},createdAt:1,updatedAt:1,startEntryId:id};
 const entry:Entry={id,comicId,contentId,title:'Test',format:'cbz',order:0,generation:1,indexState:'ready',createdAt:1,updatedAt:1,...options};
 await catalog.commit([{table:'connections',value:{id:'local',provider:'local',displayName:'Local',status:'connected',generation:1,createdAt:1,updatedAt:1}},{table:'comics',value:comic},{table:'entries',value:entry}]);
 const page=(ordinal:number):PageDescriptor=>({contentId,pageId:id+':page:'+ordinal,ordinal,name:ordinal+'.png',formatLocator:'zip:'+ordinal,locator:{entryIndex:ordinal}});
 return {comic,entry,page};
}
