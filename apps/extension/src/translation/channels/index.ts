import {msg} from '../../i18n/runtime';
import {requireHostAccess} from '../../host-permissions';
import {channelDefinition,channelDefinitions} from './registry';
import {channelSettingsKey,defaultChannel,deleteChannelSecrets,readChannelSecrets,readChannelSettings,subscribeChannelSettings,writeChannelSecrets,updateChannelSettings} from './configuration';
import type {ChannelConnection,ChannelConnectionInput,ChannelProfile} from './contracts';
export type {ChannelConnection,ChannelDefinition,ChannelField,ChannelProfile,ChannelRuntime,TranslationScope} from './contracts';
export {channelSettingsKey};

export function availableChannelProtocols(){return channelDefinitions().filter(d=>d.configurable).map(({id,label,fields})=>({id,label,fields}));}
export async function listChannels(){const settings=await readChannelSettings();return {...settings,profiles:[defaultChannel,...settings.profiles]};}
export async function selectChannel(id:string){await updateChannelSettings(value=>{if(id!==defaultChannel.id&&!value.profiles.some(p=>p.id===id))throw Error(msg('翻译渠道已移除'));return {...value,activeId:id};});}
export async function removeChannel(id:string){if(id===defaultChannel.id)throw Error(msg('内置渠道不能移除'));await updateChannelSettings(async value=>{await deleteChannelSecrets(id);return {activeId:value.activeId===id?defaultChannel.id:value.activeId,profiles:value.profiles.filter(p=>p.id!==id)};});}
export async function connectChannel(adapterId:string,name:string,input:ChannelConnectionInput,id?:string):Promise<ChannelProfile>{
  const definition=channelDefinition(adapterId);if(!definition.configurable||!definition.connect)throw Error(msg('此渠道无需配置'));
  const origins=definition.permissionOrigins?.(input)??[];
  if(origins.length)await requireHostAccess(origins);
  const connected=await definition.connect(input);let profile!:ChannelProfile;
  await updateChannelSettings(async value=>{
    const previous=id?value.profiles.find(p=>p.id===id):undefined;
    if(id&&!previous)throw Error(msg('翻译渠道已移除'));
    const key=previous?.id??crypto.randomUUID();
    const changed=previous?.adapterId!==adapterId||JSON.stringify(previous.settings)!==JSON.stringify(connected.settings);
    profile={id:key,adapterId,name:name.trim()||definition.label,settings:connected.settings,revision:previous?previous.revision+(changed?1:0):1};
    await writeChannelSecrets(key,connected.secrets);
    return {...value,profiles:[...value.profiles.filter(p=>p.id!==key),profile]};
  });return profile;
}
export async function openActiveChannel(isCurrent:()=>boolean=()=>true):Promise<ChannelConnection>{
  const value=await listChannels(),profile=value.profiles.find(p=>p.id===value.activeId)!;
  return channelDefinition(profile.adapterId).open(profile,await readChannelSecrets(profile.id),isCurrent);
}
export function subscribeChannels(listener:()=>void){
  let stopped=false,cleanup:undefined|(()=>void),generation=0;
  const watch=async()=>{const stamp=++generation;cleanup?.();cleanup=undefined;const value=await listChannels();if(stopped||stamp!==generation)return;const profile=value.profiles.find(p=>p.id===value.activeId)!;cleanup=channelDefinition(profile.adapterId).subscribe?.(listener);};
  const unsubscribe=subscribeChannelSettings(()=>{listener();void watch().catch(()=>{});});void watch().catch(()=>{});
  return ()=>{stopped=true;unsubscribe();cleanup?.();};
}
