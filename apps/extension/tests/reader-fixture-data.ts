import {hashFile} from '../src/importers/hash';
import {comicFile} from './comic-fixture';
import {catalog} from '../src/comics/repositories';
import {importLocalFile} from '../src/comics/application/import-service';
import {loadEntry} from '../src/comics/application/library-service';
import {acquirePage} from '../src/comics/pages/service';
import {RENDER_PROFILE} from '../src/comics/pages/identity';
import type {Job,ReadingEntry} from '../src/types';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {localSourceDriver} from '../src/comics/sources/local/driver';
const unregisterLocal=registerSourceDriver(localSourceDriver);

/** Synthetic image bytes go through the actual container/index/PageService pipeline. */
export async function seedReaderFixture(origin:string,scenario:string|null,makeJob:(index:number,status:Job['status'])=>Job):Promise<{copies:ReadingEntry[];ordinals:Record<string,number>;imageOrdinals:Record<string,number>}> {
  const marker='reader-fixture-source-v2';
  const imageOrdinals:Record<string,number>={};
  if(await catalog.count('comics')&&!await catalog.get('metadata',marker))throw Error('This origin contains non-fixture data. Use a new browser profile.');
  await catalog.put('metadata',{id:marker,synthetic:true});
  const account={origin,userId:scenario?'fixture-'+scenario:'fixture-reader'},scope={key:JSON.stringify([origin,scenario?'fixture-'+scenario:'fixture-reader'])};
  const titles=scenario?['自动翻译 · '+scenario]:['星光书店','星光书店与长长的夏日来信：一段会跨越两行标题的故事','星光书店 · 第三卷'];
  const existing=await catalog.list('metadata',{range:IDBKeyRange.bound(marker+':',marker+':\uffff'),limit:10});
  const ids:string[]=[];
  for(const [bookIndex,title] of titles.entries()) {
    const id=marker+':'+(scenario??'default')+':'+bookIndex;
    const saved=existing.find(value=>value.id===id);
    if(typeof saved?.entryId==='string'){Object.assign(imageOrdinals,saved.imageOrdinals);ids.push(saved.entryId);continue;}
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
      imageOrdinals[await hashFile(blob)]=index;
      files.push(new File([blob],`${title} ${String(index+1).padStart(3,'0')}.png`,{type:'image/png'}));
    }
    const result=await importLocalFile(await comicFile(title,files));
    await catalog.patch('entries',result.id,{title});
    const doc=await catalog.get('entries',result.id);
    if(!doc)throw Error('Fixture document registration failed.');
    const states:Job['status'][]=scenario==='retry'?['failed']:scenario?[]:['queued','running','failed','succeeded','no_text','outcome_unknown'];
    const pages=await catalog.listPages(doc.contentId,{limit:states.length});
    for(const [index,page] of pages.entries()) {
      const lease=await acquirePage({entryId:doc.id,contentId:doc.contentId,pageId:page.pageId,renderProfileId:RENDER_PROFILE});
      try {
        const seed=makeJob(index,states[index]);
        const job={...seed,result:seed.status==='succeeded'&&seed.output_asset_id?{key:seed.output_asset_id,recoverable:true}:undefined,id:bookIndex?`fixture-book-${bookIndex}-${seed.id}`:seed.id,image_sha256:lease.identity.imageSha256};
        await catalog.put('translationBindings',{id:JSON.stringify([scope.key,lease.identity.imageSha256]),scope:scope.key,imageSha256:lease.identity.imageSha256,updatedAt:Date.now(),payload:{translationScope:scope.key,ownerId:account.userId,apiOrigin:origin,assetId:job.input_asset_id,jobs:[job]}});
      } finally {lease.release();}
    }
    await catalog.put('metadata',{id,entryId:doc.id,imageOrdinals});ids.push(doc.id);
  }
  const copies=await Promise.all(ids.map(id=>loadEntry(id,scope)));
  const ordinals:Record<string,number>={};for(const copy of copies)copy.pages.forEach((page,index)=>{ordinals[page.id]=index;});
  unregisterLocal();
  return {copies,ordinals,imageOrdinals};
}
