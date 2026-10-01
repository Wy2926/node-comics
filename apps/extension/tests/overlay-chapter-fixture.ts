import {BlobReader,BlobWriter,ZipWriter} from '@zip.js/zip.js/index-native.js';
import {importLocalFile} from '../src/comics/application/import-service';
import {exportDocument} from '../src/comics/application/export-service';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {localSourceDriver} from '../src/comics/sources/local/driver';
import {catalog} from '../src/comics/repositories';
import {acquirePage} from '../src/comics/pages/service';
import {RENDER_PROFILE} from '../src/comics/pages/identity';
import {materializeResult} from '../src/translation/materialize';
import {loadDeliveredResult} from '../src/storage/translations/results';
import {hashFile} from '../src/importers/hash';
import type {Job,TranslationResult} from '../src/types';

export interface ChapterInput {ordinal:number;sourceUrl:string;sourceName:string;result?:TranslationResult;artifactUrl?:string;state:string}
export interface ChapterOutput {ordinal:number;state:string;kind:string;representation:string;inputBytes:number;artifactBytes:number;renderedBytes:number;sha256:string;mime:string;width:number;height:number;seconds:number}
interface Callbacks {rendered:(page:ChapterOutput,blob:Blob)=>Promise<void>;destination:WritableStream<Uint8Array>;progress?:(value:{phase:string;completed:number;total:number})=>void}
const fetched=async(url:string)=>{const response=await fetch(url);if(!response.ok)throw Error('Local fixture file is unavailable');return response.blob();};

/** Real local import, native per-page composition, and the product's streaming CBZ exporter. */
export async function exportOverlayChapter(inputs:ChapterInput[],callbacks:Callbacks){
  const release=registerSourceDriver(localSourceDriver),scope={key:'chapter-overlay-verification-'+crypto.randomUUID()};
  try{
    const writer=new ZipWriter(new BlobWriter(),{useWebWorkers:false,level:0});
    for(const input of inputs){await writer.add(String(input.ordinal).padStart(5,'0')+input.sourceName.slice(input.sourceName.lastIndexOf('.')),new BlobReader(await fetched(input.sourceUrl)));callbacks.progress?.({phase:'import',completed:input.ordinal,total:inputs.length});}
    const imported=await importLocalFile(new File([await writer.close()],'Overlay chapter.cbz',{type:'application/zip'})),entry=await catalog.get('entries',imported.id);
    if(!entry)throw Error('Missing imported chapter');
    const pages=await catalog.listPages(entry.contentId,{limit:10000});
    if(pages.length!==inputs.length)throw Error('Imported chapter page count changed');
    const outputs:ChapterOutput[]=[],byJob=new Map<string,{input:ChapterInput;output:ChapterOutput}>();
    let materializations=0;
    for(const [index,input] of inputs.entries()){
      const started=performance.now(),page=pages[index],lease=await acquirePage({entryId:entry.id,contentId:entry.contentId,pageId:page.pageId,renderProfileId:RENDER_PROFILE});
      try{
        const original=lease.blob,result=input.result,artifact=result?.artifact&&input.artifactUrl?await fetched(input.artifactUrl):undefined;
        const sha=lease.identity.imageSha256,job:Job|undefined=result?{id:crypto.randomUUID(),result:{key:result.artifact?.sha256??result.input_sha256,recoverable:true},delivery:result,image_sha256:sha,status:result.kind==='no_text'?'no_text':'succeeded',mode:'classic',target_language:'zh-Hans',phase:'succeeded',version:1,quota_pages:result.kind==='no_text'?0:1,cache_hit:false,created_at:new Date().toISOString()}:undefined;
        let rendered=original;
        if(job?.status==='succeeded'){
          rendered=await loadDeliveredResult({scope,job,isCurrent:()=>true,original:async()=>original,
            download:async()=>{materializations++;if(!artifact)throw Error('Missing fixture artifact');return artifact;}});
        }else if(result)rendered=await materializeResult(result,original,artifact);
        const bitmap=await createImageBitmap(rendered);
        const output:ChapterOutput={ordinal:input.ordinal,state:input.state,kind:result?.kind??'fallback',representation:result?.representation??'original',inputBytes:original.size,artifactBytes:artifact?.size??0,renderedBytes:rendered.size,sha256:await hashFile(rendered),mime:rendered.type,width:bitmap.width,height:bitmap.height,seconds:Math.round(performance.now()-started)/1000};bitmap.close();
        await callbacks.rendered(output,rendered);outputs.push(output);
        if(job){
          await catalog.put('translationBindings',{id:JSON.stringify([scope.key,sha]),scope:scope.key,imageSha256:sha,payload:{translationScope:scope.key,jobs:[job]},updatedAt:Date.now()});
          byJob.set(job.id,{input,output});
        }
      }finally{lease.release();}
      callbacks.progress?.({phase:'materialize',completed:index+1,total:inputs.length});
    }
    let sourceReads=0;
    const exported=await exportDocument(entry.id,{format:'cbz',images:'translation',mode:'classic',language:'zh-Hans'},{scope,signal:new AbortController().signal,isCurrent:()=>true,destination:callbacks.destination,progress:value=>callbacks.progress?.({phase:'export',completed:value.completed,total:value.total}),readResult:async(job,_signal,readOriginal)=>{
      const selected=byJob.get(job.id);if(!selected)throw Error('Unknown export binding');
      const rendered=await loadDeliveredResult({scope,job,isCurrent:()=>true,
        original:async()=>{sourceReads++;return readOriginal?.();},download:async()=>{throw Error('Export unexpectedly downloaded or recomposed an already cached result');}});
      if(await hashFile(rendered)!==selected.output.sha256)throw Error('Export image differs from verified native composition');
      return rendered;
    }});
    if(sourceReads)throw Error('Export reread originals instead of complete cached results');
    return {pages:outputs,sourceReads,materializations,archiveBytes:exported.bytes,archiveName:exported.name};
  }finally{release();}
}
