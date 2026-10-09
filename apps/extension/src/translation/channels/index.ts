import {msg} from '../../i18n/runtime';
import {requireHostAccess} from '../../host-permissions';
import {channelDefinition,channelDefinitions} from './registry';
import {channelSettingsKey,defaultChannel,deleteChannelSecrets,readChannelCredentials,readChannelSecrets,readChannelSettings,subscribeChannelSettings,writeChannelSecrets,updateChannelSettings} from './configuration';
import type {ChannelConnection,ChannelConnectionInput,ChannelProfile,LocalTranslationResultReference} from './contracts';
import {blockEntryDirectOperations,readEntryDirectOperations,removeEntryDirectOperations,transferDirectOperation,type DirectOperationOwner} from './transport/operations';
import {removeTransferReceipts} from './transport/receipts';
import {resultBlobKey} from '../../storage/translations/results';
export type {ChannelConnection,ChannelDefinition,ChannelField,ChannelProfile,ChannelRuntime,TranslationScope} from './contracts';
export {channelSettingsKey};

export async function inspectLocalTranslationEntry(entryId:string):Promise<LocalTranslationResultReference[]>{
  const refs:LocalTranslationResultReference[]=[];let after:string|undefined;
  do{
    const records=await readEntryDirectOperations(entryId,after);
    for(const record of records){
      const imageSha256=record.job.source_image_sha256??record.job.image_sha256;
      // A direct result's UUID is known before the HTTP response arrives.
      refs.push({imageSha256,scope:record.scope,key:resultBlobKey({key:record.scope},{...record.job,result:{key:record.job.id,recoverable:false}})});
      if(record.previousResult?.result)refs.push({imageSha256:record.previousResult.source_image_sha256??record.previousResult.image_sha256??imageSha256,scope:record.scope,key:resultBlobKey({key:record.scope},record.previousResult)});
    }
    after=records.length===100?records.at(-1)!.id:undefined;
  }while(after);
  for(const definition of channelDefinitions())if(definition.inspectLocalEntry)refs.push(...await definition.inspectLocalEntry(entryId));
  return [...new Map(refs.map(ref=>[ref.key,ref])).values()];
}
export async function blockLocalTranslationEntry(entryId:string,resolveShared?:(imageSha256:string)=>Promise<DirectOperationOwner|undefined>):Promise<void>{
  if(resolveShared){
    let after:string|undefined;
    do{
      const records=await readEntryDirectOperations(entryId,after);
      for(const record of records){
        const hash=record.job.image_sha256;
        // Only digest identities are shared across entries; page identities remain entry-local.
        if(!hash||record.id!==JSON.stringify([record.scope,record.job.target_language,record.job.mode,['sha256',hash]]))continue;
        const owner=await resolveShared(hash);
        if(owner)await transferDirectOperation(record,owner);
      }
      after=records.length===100?records.at(-1)!.id:undefined;
    }while(after);
  }
  await blockEntryDirectOperations(entryId);
  for(const definition of channelDefinitions())await definition.blockLocalEntry?.(entryId);
}
export async function removeLocalTranslationEntry(entryId:string):Promise<void>{
  await blockLocalTranslationEntry(entryId);let after:string|undefined;
  do{
    const records=await readEntryDirectOperations(entryId,after);
    await removeTransferReceipts(records.flatMap(record=>[record.job.id,...(record.previousResult?[record.previousResult.id]:[])]));
    after=records.length===100?records.at(-1)!.id:undefined;
  }while(after);
  await removeEntryDirectOperations(entryId);
  for(const definition of channelDefinitions())await definition.removeLocalEntry?.(entryId);
}

export function availableChannelProtocols(){
  return channelDefinitions().map(({id,label,description,guideUrl,configurable,fields})=>({
    id,label,description,guideUrl,configurable,fields,
  }));
}
export async function listChannels(){const settings=await readChannelSettings();return {...settings,profiles:[defaultChannel,...settings.profiles]};}
export async function savedChannelSecretFields(id:string){
  return Object.keys((await readChannelCredentials(id)).secrets);
}
export async function selectChannel(id:string){await updateChannelSettings(value=>{if(id!==defaultChannel.id&&!value.profiles.some(p=>p.id===id))throw Error(msg('翻译渠道已移除'));return {...value,activeId:id};});}
export async function removeChannel(id:string){if(id===defaultChannel.id)throw Error(msg('内置渠道不能移除'));await updateChannelSettings(async value=>{await deleteChannelSecrets(id);return {...value,activeId:value.activeId===id?defaultChannel.id:value.activeId,profiles:value.profiles.filter(p=>p.id!==id)};});}
export async function connectChannel(adapterId:string,name:string,input:ChannelConnectionInput,id?:string):Promise<ChannelProfile>{
  const definition=channelDefinition(adapterId);
  if(!definition.configurable||!definition.connect)throw Error(msg('此渠道无需配置'));
  const origins=definition.permissionOrigins?.(input)??[];
  if(origins.length)await requireHostAccess(origins);
  let credentials=input;
  if(id){
    const {profile,secrets}=await readChannelCredentials(id);
    if(!profile)throw Error(msg('翻译渠道已移除'));
    // Bind saved passwords to the original destination before any network call.
    const unchanged=profile.adapterId===adapterId
      &&Object.keys(profile.settings).length===Object.keys(input.settings).length
      &&Object.entries(profile.settings).every(([key,value])=>input.settings[key]===value);
    if(unchanged){
      const reused={...input.secrets};
      for(const field of definition.fields){
        if(field.type==='password'&&!reused[field.key]&&secrets[field.key]){
          reused[field.key]=secrets[field.key];
        }
      }
      credentials={...input,secrets:reused};
    }
  }
  const connected=await definition.connect(credentials);
  let profile!:ChannelProfile;
  await updateChannelSettings(async value=>{
    const previous=id?value.profiles.find(p=>p.id===id):undefined;
    if(id&&!previous)throw Error(msg('翻译渠道已移除'));
    const key=previous?.id??crypto.randomUUID();
    const changed=previous?.adapterId!==adapterId||JSON.stringify(previous.settings)!==JSON.stringify(connected.settings);
    profile={id:key,adapterId,name:name.trim()||definition.label,settings:connected.settings,revision:previous?previous.revision+(changed?1:0):1};
    await writeChannelSecrets(key,connected.secrets,profile);
    return {...value,profiles:[...value.profiles.filter(p=>p.id!==key),profile]};
  });
  return profile;
}
export async function openActiveChannel(isCurrent:()=>boolean=()=>true):Promise<ChannelConnection>{
  const value=await listChannels(),profile=value.profiles.find(p=>p.id===value.activeId)!;
  return channelDefinition(profile.adapterId).open(profile,await readChannelSecrets(profile.id,profile),isCurrent);
}
export function subscribeChannels(listener:()=>void){
  let stopped=false,cleanup:undefined|(()=>void),generation=0;
  const watch=async()=>{const stamp=++generation;cleanup?.();cleanup=undefined;const value=await listChannels();if(stopped||stamp!==generation)return;const profile=value.profiles.find(p=>p.id===value.activeId)!;cleanup=channelDefinition(profile.adapterId).subscribe?.(listener);};
  const unsubscribe=subscribeChannelSettings(()=>{listener();void watch().catch(()=>{});});void watch().catch(()=>{});
  return ()=>{stopped=true;unsubscribe();cleanup?.();};
}
