import {msg} from '../../../../i18n/runtime';
import {assertCurrent} from '../../../../concurrency';
import {fallbackLanguages,type Capabilities} from '../../../../types';
import {MAX_READER_TARGETS} from '../../../../reading-window';
import {loadResultBlob,resultBlobKey} from '../../../../storage/translations/results';
import {readChannelSettings,updateChannelSettings} from '../../configuration';
import type {ChannelDefinition} from '../../contracts';
import {configFields,needsInternet} from './config';
import {fontPreferenceKey,serviceScope,serviceToken,serviceSelection,saveCommonSettings,localSettings,profileConfig} from './services';
import {resourceManager,fontDownloads} from './resources';
import {localFonts} from '../../../font-resources';
import {effectiveTranslationFont} from '../../../fonts';
import {ShinobuRuntime} from './runtime';
import {entryOperations,blockEntry,removeEntry} from './operations';
import {errorMessage} from './errors';
import {localLanguages} from './languages';
const capabilities=():Capabilities=>({modes:[{id:'classic',label:msg('翻译'),enabled:true,languages:localLanguages}],languages:fallbackLanguages,limits:{max_bytes:Number.MAX_SAFE_INTEGER,max_pixels:Number.MAX_SAFE_INTEGER,max_dimension:Number.MAX_SAFE_INTEGER,max_translation_ids:MAX_READER_TARGETS},entitlements:null,translation_fonts:localFonts});
export const definition:ChannelDefinition={
  id:'shinobu',get label(){return msg('浏览器本地翻译');},configurable:false,
  get description(){return msg('本机识别与嵌字，正文使用 Google 或兼容 LLM；模型需手动下载。');},
  fields:[],get defaultSettings(){return localSettings({});},
  async open(profile,secrets,isCurrent){
    const config=profileConfig(profile),scope={key:serviceScope(profile)},preferences=await readChannelSettings(),fontKey=fontPreferenceKey(profile),fonts=preferences.fontPreferences?.[fontKey]??{};
    let disposed=false;const current=()=>!disposed&&isCurrent();
    return {
      key:JSON.stringify([scope.key,config,fonts]),scope,label:profile.name,capabilities:capabilities(),available:true,requiresInternet:needsInternet(config),analyticsCategory:'local',isCurrent:current,
      fontSelection:{fonts:localFonts,downloads:fontDownloads,description:msg('此字体用于本地译图嵌字，需先下载完整字库。更换后，新翻译或手动重译的页面使用新字体。'),value:language=>effectiveTranslationFont(localFonts,language,fonts[language]),async select(language,value){
        assertCurrent(current);const selected=effectiveTranslationFont(localFonts,language,value);
        if(!selected||value&&value!==selected)throw Error(errorMessage('FONT_UNAVAILABLE'));
        await updateChannelSettings(settings=>({...settings,fontPreferences:{...settings.fontPreferences,[fontKey]:{...fonts,...settings.fontPreferences?.[fontKey],[language]:selected}}}));
      }},
      options:{fields:configFields(),values:{backend:config.backend,ocrFilter:config.ocrFilter},settingsLabel:msg('本机识别设置'),services:serviceSelection(profile,secrets,current),resources:resourceManager(fonts),
        save:values=>saveCommonSettings(profile,values,current)},
      createRuntime(options){return new ShinobuRuntime(scope,{...options,isCurrent:()=>current()&&options.isCurrent()},config,effectiveTranslationFont(localFonts,options.language,options.fontId??fonts[options.language])??localFonts[0].id,serviceToken(profile,secrets));},
      async validateResult(){assertCurrent(current);},
      readResult(job,signal){signal?.throwIfAborted();return loadResultBlob({scope,job,isCurrent:current});},
      dispose(){disposed=true;},
    };
  },
  async startLocalHost(changed){return (await import('./host')).createHost(changed);},
  async inspectLocalEntry(entryId){
    const refs=[];let after:string|undefined;
    do{const records=await entryOperations(entryId,after);for(const r of records)for(const job of [r.job,...(r.previousResult?[r.previousResult]:[])])if(job.result)refs.push({scope:r.scope,key:resultBlobKey({key:r.scope},job),imageSha256:job.image_sha256});after=records.length===100?records.at(-1)!.id:undefined;}while(after);return refs;
  },
  async blockLocalEntry(entryId){await blockEntry(entryId);},
  async removeLocalEntry(entryId){await removeEntry(entryId);},
};
