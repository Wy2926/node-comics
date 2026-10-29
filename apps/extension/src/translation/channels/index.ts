import {msg} from '../../i18n/runtime';
import {requireHostAccess} from '../../host-permissions';
import {channelDefinition,channelDefinitions} from './registry';
import {channelSettingsKey,defaultChannel,deleteChannelSecrets,readChannelCredentials,readChannelSecrets,readChannelSettings,subscribeChannelSettings,writeChannelSecrets,updateChannelSettings} from './configuration';
import type {ChannelConnection,ChannelConnectionInput,ChannelProfile,LocalTranslationResultReference} from './contracts';
import {blockEntryDirectOperations,readEntryDirectOperations,removeEntryDirectOperations,transferDirectOperation,type DirectOperationOwner} from './transport/operations';
import {removeTransferReceipts} from '../../image-transfer/receipts';
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
  return channelDefinitions().map(({id,label,description,status,guideUrl,configurable,fields})=>({
    id,label,description,status,guideUrl,configurable,fields,
  }));
}
function channelProfiles(saved:ChannelProfile[]):ChannelProfile[]{
  const builtins=channelDefinitions().filter(definition=>!definition.configurable).map(definition=>{
    const previous=saved.find(profile=>profile.adapterId===definition.id);
    return {id:previous?.id??definition.id,adapterId:definition.id,name:definition.label,revision:previous?.revision??1,settings:previous?.settings??{...definition.defaultSettings}};
  });
  return [...builtins,...saved.filter(profile=>!builtins.some(builtin=>builtin.id===profile.id||builtin.adapterId===profile.adapterId))];
}
export async function listChannels(){
  const settings=await readChannelSettings(),profiles=channelProfiles(settings.profiles);
  return {...settings,profiles,activeId:profiles.some(profile=>profile.id===settings.activeId)?settings.activeId:defaultChannel.id};
}
export async function savedChannelSecretFields(id:string){
  return Object.keys((await readChannelCredentials(id)).secrets);
}
export async function selectChannel(id:string){
  await updateChannelSettings(value=>{
    const profile=channelProfiles(value.profiles).find(profile=>profile.id===id);
    if(!profile)throw Error(msg('翻译渠道已移除'));
    // Persist an editable built-in before its adapter can save options or start work.
    const stored=id===defaultChannel.id||value.profiles.some(item=>item.id===id&&item.adapterId===profile.adapterId);
    return {...value,activeId:id,profiles:stored?value.profiles:[...value.profiles.filter(item=>item.id!==id),profile]};
  });
}
export async function removeChannel(id:string){
  await updateChannelSettings(async value=>{
    const profile=value.profiles.find(item=>item.id===id);
    if(channelDefinitions().some(definition=>!definition.configurable&&(definition.id===id||definition.id===profile?.adapterId)))throw Error(msg('内置渠道不能移除'));
    await deleteChannelSecrets(id);
    return {...value,activeId:value.activeId===id?defaultChannel.id:value.activeId,profiles:value.profiles.filter(p=>p.id!==id)};
  });
}
export async function connectChannel(adapterId:string,name:string,input:ChannelConnectionInput,id?:string):Promise<ChannelProfile>{
  const definition=channelDefinition(adapterId);
  if(!definition.configurable||!definition.connect||id&&channelDefinitions().some(item=>!item.configurable&&item.id===id))throw Error(msg('此渠道无需配置'));
  const origins=definition.permissionOrigins?.(input)??[];
  if(origins.length)await requireHostAccess(origins);
  let credentials=input;
  if(id){
    const {profile,secrets}=await readChannelCredentials(id);
    if(!profile)throw Error(msg('翻译渠道已移除'));
    if(channelDefinitions().some(item=>!item.configurable&&item.id===profile.adapterId))throw Error(msg('此渠道无需配置'));
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
export async function openActiveChannel(isCurrent:()=>boolean=()=>true,options?:{deferPolicy?:boolean}):Promise<ChannelConnection>{
  const value=await listChannels(),profile=value.profiles.find(p=>p.id===value.activeId)!;
  return channelDefinition(profile.adapterId).open(profile,await readChannelSecrets(profile.id,profile),isCurrent,options);
}
export function subscribeChannels(listener:()=>void){
  let stopped=false,cleanup:undefined|(()=>void),generation=0;
  const watch=async()=>{const stamp=++generation;cleanup?.();cleanup=undefined;const value=await listChannels();if(stopped||stamp!==generation)return;const profile=value.profiles.find(p=>p.id===value.activeId)!;cleanup=channelDefinition(profile.adapterId).subscribe?.(listener);};
  const unsubscribe=subscribeChannelSettings(()=>{listener();void watch().catch(()=>{});});void watch().catch(()=>{});
  return ()=>{stopped=true;unsubscribe();cleanup?.();};
}
