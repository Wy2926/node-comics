import {assertCurrent} from '../../../../concurrency';
import {requireHostAccess} from '../../../../host-permissions';
import {msg} from '../../../../i18n/runtime';
import {readChannelCredentials,updateChannelSettings,writeChannelSecrets} from '../../configuration';
import type {ChannelProfile,ChannelServiceSelection} from '../../contracts';
import {configValues,parseConfig,serviceFields} from './config';
import {errorMessage} from './errors';

interface TextService {id:string;name:string;scope:string;values:Record<string,string>}
interface Services {selectedId:string;items:TextService[]}
const secretKey=(id:string)=>'text-service:'+id;
export const fontPreferenceKey=(profile:ChannelProfile)=>'local-fonts:'+profile.id;
const textValues=(values:Record<string,string>)=>{
  const {backend:_backend,ocrFilter:_filter,...text}=configValues(parseConfig({...values,provider:'llm'}));
  return text;
};
export function readServices(profile:ChannelProfile):Services{
    try{
      const items:TextService[]=JSON.parse(profile.settings.textServices);
      if(!Array.isArray(items)||items.length>20||new Set(items.map(item=>item.id)).size!==items.length)throw Error();
      for(const item of items){
        if(!item||!/^[-\w]{1,64}$/.test(item.id)||item.id==='google'||!item.name||item.name.length>80||typeof item.scope!=='string'||!item.values)throw Error();
        item.values=textValues(item.values);
      }
      const selectedId=profile.settings.textServiceId;
      if(selectedId!=='google'&&!items.some(item=>item.id===selectedId))throw Error();
      return {selectedId,items};
    }catch{throw Error(errorMessage('TEXT_CONFIG_INVALID'));}
}
export function serviceScope(profile:ChannelProfile){
  const services=readServices(profile);
  return services.selectedId==='google'?JSON.stringify([profile.id,'google']):services.items.find(item=>item.id===services.selectedId)!.scope;
}
export function profileConfig(profile:ChannelProfile){
  const state=readServices(profile),selected=state.items.find(item=>item.id===state.selectedId);
  return parseConfig({...selected?.values,provider:selected?'llm':'google',backend:profile.settings.backend,ocrFilter:profile.settings.ocrFilter});
}
function providerSecrets(secrets:Record<string,string>){
  return Object.fromEntries(Object.entries(secrets).filter(([key])=>key.startsWith('text-service:')));
}
export function localSettings(common:Record<string,string>,state:Services={selectedId:'google',items:[]}){
  const {backend,ocrFilter}=parseConfig({backend:common.backend,ocrFilter:common.ocrFilter});
  return {backend,ocrFilter,textServices:JSON.stringify(state.items),textServiceId:state.selectedId};
}
async function mutate(profile:ChannelProfile,isCurrent:()=>boolean,change:(state:Services,secrets:Record<string,string>)=>void,common:Record<string,string>={}){
  assertCurrent(isCurrent);
  const saved=await readChannelCredentials(profile.id);
  if(!saved.profile)throw Error(msg('翻译渠道已移除'));
  const state=readServices(profile),secrets=providerSecrets(saved.secrets);
  change(state,secrets);
  const settings=localSettings({...profile.settings,...common},state);
  const activeToken=state.selectedId==='google'?'':secrets[secretKey(state.selectedId)];
  if(activeToken)secrets.token=activeToken;
  await updateChannelSettings(async value=>{
    assertCurrent(isCurrent);
    const existing=value.profiles.find(item=>item.id===profile.id);
    if(!existing||existing.revision!==profile.revision||JSON.stringify(existing.settings)!==JSON.stringify(profile.settings))throw Error(errorMessage('TEXT_CONFIG_CHANGED'));
    const revised={...existing,revision:existing.revision+1,settings};
    await writeChannelSecrets(profile.id,secrets,revised);
    return {...value,profiles:value.profiles.map(item=>item.id===profile.id?revised:item)};
  });
}
export async function saveCommonSettings(profile:ChannelProfile,values:Record<string,string>,isCurrent:()=>boolean){
  try{localSettings(values);}catch{throw Error(errorMessage('TEXT_CONFIG_INVALID'));}
  await mutate(profile,isCurrent,()=>{},values);
}
export function serviceSelection(profile:ChannelProfile,secrets:Record<string,string>,isCurrent:()=>boolean):ChannelServiceSelection{
  const state=readServices(profile),stored=providerSecrets(secrets);
  return {
    label:msg('正文翻译服务'),description:msg('识别和绘图在浏览器内完成，仅文字发送至所选服务。'),addLabel:msg('添加 LLM 供应商'),selectedId:state.selectedId,fields:serviceFields(),
    items:[{id:'google',label:msg('谷歌翻译'),description:msg('无需配置，使用 Google Translate 翻译正文。')},...state.items.map(item=>({id:item.id,label:item.name,description:item.values.model+' · '+new URL(item.values.baseUrl).host,values:{...item.values,name:item.name},savedSecrets:stored[secretKey(item.id)]?['token']:[]}))],
    async select(id){
      if(id===state.selectedId)return;
      if(id!=='google'&&!state.items.some(item=>item.id===id))throw Error(errorMessage('TEXT_CONFIG_INVALID'));
      await mutate(profile,isCurrent,next=>{next.selectedId=id;});
    },
    async save(values,id){
      const name=values.name?.trim();
      if(!name||name.length>80)throw Error(msg('请填写不超过 80 个字的供应商名称。'));
      let config:Record<string,string>;try{config=textValues(values);}catch{throw Error(errorMessage('TEXT_CONFIG_INVALID'));}
      const previous=id?state.items.find(item=>item.id===id):undefined;
      if(id&&!previous)throw Error(errorMessage('TEXT_CONFIG_CHANGED'));
      if(!id&&state.items.length>=20)throw Error(msg('最多保存 20 个 LLM 供应商。'));
      await requireHostAccess([new URL(config.baseUrl).origin+'/*']);
      await mutate(profile,isCurrent,(next,credentials)=>{
        const key=id??crypto.randomUUID(),changed=previous?.values.baseUrl!==config.baseUrl||!!values.token;
        const item:TextService={id:key,name,values:config,scope:previous&&!changed?previous.scope:JSON.stringify([profile.id,'llm',key,crypto.randomUUID()])};
        if(values.token)credentials[secretKey(key)]=values.token;
        else if(previous?.values.baseUrl!==config.baseUrl)delete credentials[secretKey(key)];
        next.items=[...next.items.filter(item=>item.id!==key),item];next.selectedId=key;
      });
    },
    async remove(id){
      if(!state.items.some(item=>item.id===id))throw Error(errorMessage('TEXT_CONFIG_INVALID'));
      await mutate(profile,isCurrent,(next,credentials)=>{
        next.items=next.items.filter(item=>item.id!==id);delete credentials[secretKey(id)];
        if(next.selectedId===id)next.selectedId='google';
      });
    },
  };
}
