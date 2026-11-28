import {assertCurrent} from '../../../../concurrency';
import {requireHostAccess} from '../../../../host-permissions';
import {msg} from '../../../../i18n/runtime';
import {readChannelCredentials,updateChannelSettings,writeChannelSecrets} from '../../configuration';
import {ChannelServiceError,type ChannelProfile,type ChannelServiceSelection} from '../../contracts';
import {configValues,parseConfig,draftConfig,serviceEndpoint,serviceFields,changeServiceValues,type ShinobuConfig} from './config';
import {providerPreset} from './providers';
import {errorMessage,serviceError} from './errors';
import {listModels} from './text/models';
import {llmTranslate} from './text/openai-compatible';
import {anthropicTranslate} from './text/anthropic';
import {redactProbeText} from './text/llm-http';

interface TextService {id:string;name:string;scope:string;values:Record<string,string>}
interface Services {selectedId:string;items:TextService[]}
const secretKey=(id:string)=>'text-service:'+id;
export const fontPreferenceKey=(profile:ChannelProfile)=>'local-fonts:'+profile.id;
const textValues=(config:ShinobuConfig)=>{
  const {backend:_backend,ocrFilter:_filter,...text}=configValues(config);
  return text;
};
export function readServices(profile:ChannelProfile):Services{
    try{
      const items:TextService[]=JSON.parse(profile.settings.textServices);
      if(!Array.isArray(items)||new Set(items.map(item=>item.id)).size!==items.length)throw Error();
      for(const item of items){
        if(!item||!/^[-\w]{1,64}$/.test(item.id)||item.id==='google'||!item.name||item.name.length>80||typeof item.scope!=='string'||!item.values)throw Error();
        item.values=textValues(parseConfig({...item.values,provider:'llm'}));
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
export function serviceToken(profile:ChannelProfile,secrets:Record<string,string>){
  const {selectedId}=readServices(profile);
  return selectedId==='google'?'':secrets[secretKey(selectedId)]??'';
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
  function existing(id?:string){
    const item=state.items.find(item=>item.id===id);
    if(id&&!item)throw Error(errorMessage('TEXT_CONFIG_CHANGED'));
    return item;
  }
  async function probe<T>(values:Record<string,string>,id:string|undefined,signal:AbortSignal,baseUrl:string,models:boolean,send:(token:string,signal:AbortSignal)=>Promise<T>){
    assertCurrent(isCurrent);signal.throwIfAborted();
    const item=existing(id);
    await requireHostAccess([baseUrl]);
    // 包含端口和路径，不能只按域名复用凭据；试译和列模型均不创建任务或写入草稿。
    const token=values.token?.trim()||(item?.values.baseUrl===baseUrl?stored[secretKey(item.id)]:'')||'';
    assertCurrent(isCurrent);signal.throwIfAborted();
    const deadline=AbortSignal.timeout(models?15_000:60_000),combined=AbortSignal.any([signal,deadline]);
    let result:T;
    try{result=await send(token,combined);combined.throwIfAborted();}
    catch(error){signal.throwIfAborted();throw serviceError(deadline.aborted?Error('TEXT_TIMEOUT'):error,models);}
    assertCurrent(isCurrent);return result;
  }
  return {
    get label(){return msg('正文翻译服务');},get description(){return msg('识别和绘图在浏览器内完成，仅文字发送至所选服务。');},get addLabel(){return msg('添加 LLM 供应商');},selectedId:state.selectedId,initialValues:providerPreset('deepseek'),fields:serviceFields,changeValues:changeServiceValues,
    items:[{id:'google',get label(){return msg('谷歌翻译');},get description(){return msg('无需配置，使用 Google Translate 翻译正文。');}},...state.items.map(item=>({id:item.id,label:item.name,description:item.values.model+' · '+new URL(item.values.baseUrl).host,values:{...item.values,name:item.name},savedSecrets:stored[secretKey(item.id)]?['token']:[]}))],
    async listModels(values,id,signal,inspect){
      let endpoint:ReturnType<typeof serviceEndpoint>;
      try{endpoint=serviceEndpoint(values);}catch(error){throw serviceError(error);}
      return probe(values,id,signal,endpoint.baseUrl,true,(token,signal)=>listModels(endpoint,token,signal,inspect));
    },
    async test(values,id,language,signal,inspect){
      const config=draftConfig(values),translate=config.protocol==='anthropic'?anthropicTranslate:llmTranslate;
      return probe(values,id,signal,config.baseUrl,false,async(token,signal)=>{
        const {sample}=await translate(config,{sample:language==='ja'?'Hello!':'こんにちは！'},language,token,signal,fetch,inspect);
        return redactProbeText(sample,token);
      });
    },
    async select(id){
      if(id===state.selectedId)return;
      if(id!=='google'&&!state.items.some(item=>item.id===id))throw Error(errorMessage('TEXT_CONFIG_INVALID'));
      await mutate(profile,isCurrent,next=>{next.selectedId=id;});
    },
    async save(values,id){
      const config=textValues(draftConfig(values)),previous=existing(id);
      const name=values.name?.trim()||config.model.slice(0,80),token=values.token?.trim();
      if(name.length>80)throw new ChannelServiceError(msg('请填写不超过 80 个字的供应商名称。'),'name');
      await requireHostAccess([config.baseUrl]);
      await mutate(profile,isCurrent,(next,credentials)=>{
        const key=id??crypto.randomUUID(),changed=previous?.values.baseUrl!==config.baseUrl||previous?.values.protocol!==config.protocol||!!token;
        const item:TextService={id:key,name,values:config,scope:previous&&!changed?previous.scope:JSON.stringify([profile.id,'llm',key,crypto.randomUUID()])};
        if(token)credentials[secretKey(key)]=token;
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
