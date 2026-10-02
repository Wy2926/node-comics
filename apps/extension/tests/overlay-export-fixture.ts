import {BlobReader,BlobWriter,ZipReader} from '@zip.js/zip.js/index-native.js';
import {comicFile} from './comic-fixture';
import {importLocalFile} from '../src/comics/application/import-service';
import {exportDocument} from '../src/comics/application/export-service';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {localSourceDriver} from '../src/comics/sources/local/driver';
import {catalog} from '../src/comics/repositories';
import {acquirePage} from '../src/comics/pages/service';
import {RENDER_PROFILE} from '../src/comics/pages/identity';
import {materializeResult} from '../src/translation/materialize';
import {hashFile} from '../src/importers/hash';
import type {Job,TranslationResult} from '../src/types';

/** Exercise the actual one-page CBZ import/export path using a local delivered overlay. */
export async function exportOverlay(original:Blob,artifact:Blob,result:TranslationResult){
  const release=registerSourceDriver(localSourceDriver);
  try{
    const imported=await importLocalFile(await comicFile('Overlay browser export',[original])),entry=await catalog.get('entries',imported.id);
    if(!entry)throw Error('Missing test entry');
    const [page]=await catalog.listPages(entry.contentId,{limit:1});
    const reference={entryId:entry.id,contentId:entry.contentId,pageId:page.pageId,renderProfileId:RENDER_PROFILE};
    const lease=await acquirePage(reference),sha=lease.identity.imageSha256;lease.release();
    const scope={key:'isolated-overlay-export'},job:Job={id:crypto.randomUUID(),result:{key:result.artifact!.sha256,recoverable:true},delivery:result,image_sha256:sha,status:'succeeded',mode:'classic',target_language:'zh-Hans',phase:'succeeded',version:1,quota_pages:1,cache_hit:false,created_at:new Date().toISOString()};
    await catalog.put('translationBindings',{id:JSON.stringify([scope.key,sha]),scope:scope.key,imageSha256:sha,payload:{translationScope:scope.key,jobs:[job]},updatedAt:Date.now()});
    let sourceReads=0;
    const exported=await exportDocument(entry.id,{format:'cbz',images:'translation',mode:'classic',language:'zh-Hans'},{scope,signal:new AbortController().signal,isCurrent:()=>true,readResult:async(job,_signal,readOriginal)=>{sourceReads++;return materializeResult(job.delivery!,await readOriginal?.(),artifact);}});
    const reader=new ZipReader(new BlobReader(exported.blob!));
    try{
      const files=await reader.getEntries(),image=files.find(file=>/^00001\.(png|webp|jpg)$/.test(file.filename));
      if(!image||image.directory)throw Error('Export did not contain a complete image');
      const blob=await image.getData(new BlobWriter());
      return {sourceReads,imageName:image.filename,imageSha256:await hashFile(blob),imageBytes:blob.size,archive:[...new Uint8Array(await exported.blob!.arrayBuffer())]};
    }finally{await reader.close();}
  }finally{release();}
}
