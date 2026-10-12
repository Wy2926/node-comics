import {API_ORIGIN} from '../src/service';
import {defaults} from '../src/types';
import {saveSettings} from '../src/comics/application/preferences';
import {seedReaderFixture} from './reader-fixture-data';
import {readAuth} from '../src/auth/storage';
import {listChannels,selectChannel} from '../src/translation/channels';
import {clearStorage} from '../src/comics/application/source-lifecycle';
import {catalog} from '../src/comics/repositories';
import {retainContainer} from '../src/storage/containers';
import {hashFile} from '../src/importers/hash';
import {readProcessingSettings, updateProcessingSettings} from '../src/image-processing/settings';
import {clearProcessingCache} from '../src/image-processing/storage';
import {definition as localTranslation} from '../src/translation/channels/adapters/manga-translator-ui/definition';

if(location.origin!=='http://127.0.0.1:5176')throw Error('Use a fresh profile on the isolated fixture origin.');
await saveSettings({...defaults,uiLanguage:'zh-CN',appearance:'light'});
const {copies}=await seedReaderFixture(API_ORIGIN,'local',()=>{throw Error('Local fixture must not seed official jobs.');});
const first=(await catalog.get('entries',copies[0].id))!,pages=await catalog.listPages(first.contentId,{limit:2});
const chapterContentIds=[first.contentId],pageReads:string[]=[];
await catalog.patch('entries',first.id,{sequenceId:'channel-fixture'});
// All chapters have a real local index; only the current reading window should load it.
for(let order=1;order<100;order++){
  const id=first.id+':chapter:'+order,contentId=first.contentId+':chapter:'+order;
  const chapterPages=pages.map(page=>({...page,contentId,pageId:page.pageId+':chapter:'+order}));
  await retainContainer(first.containerId!,contentId);
  await catalog.put('entries',{...first,id,contentId,order,sequenceId:'channel-fixture',title:'合成章节 '+(order+1),pageCount:chapterPages.length,knownTotal:chapterPages.length,coverPageId:chapterPages[0].pageId});
  await catalog.putPages(id,contentId,chapterPages,first.generation);chapterContentIds.push(contentId);
}
const listPages=catalog.listPages;
catalog.listPages=(contentId,options)=>{pageReads.push(contentId);return listPages(contentId,options);};
const originalFetch=window.fetch.bind(window);
const output=await (await originalFetch('/samples/starlight-bookshop.png')).blob();
const outputSha256=await hashFile(output),bitmap=await createImageBitmap(output);
const enhancedCanvas=new OffscreenCanvas(bitmap.width*2,bitmap.height*2),enhancedContext=enhancedCanvas.getContext('2d')!;
enhancedContext.drawImage(bitmap,0,0,enhancedCanvas.width,enhancedCanvas.height);bitmap.close();
const enhancedOutput=await enhancedCanvas.convertToBlob({type:'image/png'});enhancedCanvas.width=enhancedCanvas.height=1;
const enhancementWaiters:(()=>void)[]=[];
const state={loginCount:0,requests:[] as {language:string;token:boolean;hasImage:boolean}[],officialTranslations:0,fail:false,
  parentReads:[] as string[],blockedParentJobs:[] as string[],parentSourceKeys:copies[0].pages.slice(0,2).map(page=>page.blobKey),
  enhancements:[] as {sha256:string;bytes:number;fields:Record<string,string>;startedAt:number;duration?:number}[],enhancementFail:false,enhancementDelay:180,
  holdEnhancements:false,get heldEnhancements(){return enhancementWaiters.length;},
  releaseEnhancements:()=>{state.holdEnhancements=false;for(const release of enhancementWaiters.splice(0))release();},
  outputSha256,readProcessingSettings,updateProcessingSettings,clearProcessingCache,
  listChannels,selectChannel,readAuth,chapterContentIds,pageReads,clearCache:()=>clearStorage('translations')};
Object.assign(window,{channelFixture:state});
const openTranslation=localTranslation.open;
localTranslation.open=async(...args)=>{
  const channel=await openTranslation(...args),read=channel.readResult;
  channel.readResult=async(job,...rest)=>{
    state.parentReads.push(job.id);
    if(state.blockedParentJobs.includes(job.id))throw Error('Synthetic parent image is unavailable');
    return read(job,...rest);
  };
  return channel;
};
window.fetch=async(input,init={})=>{
  const url=new URL(String(input),location.origin);
  if(url.pathname==='/fixture-nunif/api'){
    const form=init.body as FormData,blob=form.get('file') as Blob;
    const entry={sha256:await hashFile(blob),bytes:blob.size,fields:Object.fromEntries(['style','noise','scale','format'].map(key=>[key,String(form.get(key))])),startedAt:performance.now(),duration:0};
    state.enhancements.push(entry);
    if(state.holdEnhancements)await new Promise<void>(resolve=>enhancementWaiters.push(resolve));
    await new Promise(resolve=>setTimeout(resolve,state.enhancementDelay));entry.duration=performance.now()-entry.startedAt;
    if(state.enhancementFail)return new Response('synthetic enhancement failure',{status:503});
    return new Response(enhancedOutput,{headers:{'Content-Type':'image/png'}});
  }
  if(url.pathname==='/fixture-mtu/auth/login'){
    state.loginCount++;
    const input=JSON.parse(String(init.body));
    return Response.json(input.username==='fixture'&&input.password==='fixture-pass'?{success:true,token:'synthetic-local-token'}:{success:false});
  }
  if(url.pathname==='/fixture-mtu/translate/with-form/image'){
    const form=init.body as FormData;
    state.requests.push({language:JSON.parse(String(form.get('config'))).translator.target_lang,token:new Headers(init.headers).get('X-Session-Token')==='synthetic-local-token',hasImage:form.get('image') instanceof Blob});
    await new Promise(resolve=>setTimeout(resolve,180));
    if(state.fail)return new Response('synthetic failure',{status:503});
    return new Response(output,{headers:{'Content-Type':'image/png'}});
  }
  if(url.pathname.startsWith('/v1/')){
    if(url.pathname.startsWith('/v1/translations'))state.officialTranslations++;
    return Response.json({error:{message:'Official service is disabled in this signed-out fixture'}},{status:401});
  }
  if(url.origin!==location.origin)throw Error('External traffic blocked in isolated fixture');
  return originalFetch(input,init);
};
await import('../src/main');
