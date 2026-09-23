import {catalog} from '../src/comics/repositories';
import {importImageAlbum} from '../src/comics/application/import-service';
import {loadDocument} from '../src/comics/application/library-service';
import {acquirePage} from '../src/comics/pages/service';
import {RENDER_PROFILE} from '../src/comics/pages/identity';
import type {Job,ReadingCopy} from '../src/types';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {localSourceDriver} from '../src/comics/sources/local/driver';
registerSourceDriver(localSourceDriver);

/** Synthetic image bytes go through the actual container/index/PageService pipeline. */
export async function seedReaderFixture(origin:string,scenario:string|null,makeJob:(index:number,status:Job['status'])=>Job):Promise<{copies:ReadingCopy[];ordinals:Record<string,number>}> {
  const marker='reader-fixture-source-v1';
  if(await catalog.count('works')&&!await catalog.get('metadata',marker))throw Error('This origin contains non-fixture data. Use a new browser profile.');
  await catalog.put('metadata',{id:marker,synthetic:true});
  const account={origin,userId:scenario?'fixture-'+scenario:'fixture-reader'};
  const titles=scenario?['自动翻译 · '+scenario]:['星光书店','星光书店与长长的夏日来信：一段会跨越两行标题的故事','星光书店 · 第三卷'];
  const existing=await catalog.list('metadata',{range:IDBKeyRange.bound(marker+':',marker+':\uffff'),limit:10});
  const ids:string[]=[];
  for(const [bookIndex,title] of titles.entries()) {
    const id=marker+':'+(scenario??'default')+':'+bookIndex;
    const saved=existing.find(value=>value.id===id);
    if(typeof saved?.documentId==='string'){ids.push(saved.documentId);continue;}
    const count=scenario?(['retry','connection'].includes(scenario)?1:30):bookIndex===0?120:9;
    const files:File[]=[];
    for(let index=0;index<count;index++) {
      const canvas=new OffscreenCanvas(640,900),context=canvas.getContext('2d')!;
      context.fillStyle=`hsl(${(index*37+bookIndex*83)%360} 65% 88%)`;context.fillRect(0,0,640,900);
      context.fillStyle='#fff';context.fillRect(40,45,560,810);
      context.fillStyle='#25334a';context.font='32px sans-serif';context.fillText('ORIGINAL READER FIXTURE',65,125);
      context.font='60px sans-serif';context.fillText(`PAGE ${index+1}`,95,425);
      context.font='24px sans-serif';context.fillText(`${scenario??'history'} / ${bookIndex+1}`,95,700);
      const blob=await canvas.convertToBlob({type:'image/png'});
      files.push(new File([blob],`${title} ${String(index+1).padStart(3,'0')}.png`,{type:'image/png'}));
    }
    const result=await importImageAlbum(files,{title,kind:'chapter'});
    await catalog.patch('documents',result.id,{title});
    const doc=await catalog.get('documents',result.id);
    if(!doc)throw Error('Fixture document registration failed.');
    const states:Job['status'][]=scenario==='retry'?['failed']:scenario?[]:['queued','running','failed','succeeded','no_text','outcome_unknown'];
    const pages=await catalog.listPages(doc.revisionId,{limit:states.length});
    for(const [index,page] of pages.entries()) {
      const lease=await acquirePage({documentId:doc.id,revisionId:doc.revisionId,pageId:page.pageId,renderProfileId:RENDER_PROFILE});
      try {
        const seed=makeJob(index,states[index]);
        const job={...seed,id:bookIndex?`fixture-book-${bookIndex}-${seed.id}`:seed.id,image_sha256:lease.identity.imageSha256};
        await catalog.put('translationBindings',{id:JSON.stringify([origin,account.userId,lease.identity.imageSha256]),apiOrigin:origin,userId:account.userId,imageSha256:lease.identity.imageSha256,updatedAt:Date.now(),payload:{ownerId:account.userId,apiOrigin:origin,assetId:job.input_asset_id,jobs:[job]}});
      } finally {lease.release();}
    }
    await catalog.put('metadata',{id,documentId:doc.id});ids.push(doc.id);
  }
  const copies=await Promise.all(ids.map(id=>loadDocument(id,account)));
  const ordinals:Record<string,number>={};for(const copy of copies)copy.pages.forEach((page,index)=>{ordinals[page.id]=index;});
  return {copies,ordinals};
}
