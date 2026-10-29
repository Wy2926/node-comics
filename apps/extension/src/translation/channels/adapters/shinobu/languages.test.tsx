import {afterEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {TargetLanguage} from '../../../../ui/TargetLanguage';
import {TranslationFontPicker} from '../../../../ui/TranslationFontPicker';
import {fallbackLanguages,supportsLanguage} from '../../../../types';
import * as configuration from '../../configuration';
import {definition} from './definition';
import {localLanguage} from './languages';
import {readFileSync} from 'node:fs';
import {uiLanguages} from '../../../../i18n/locales';
import {getDictionary,getLocale,installDictionary,type Dictionary} from '../../../../i18n/runtime';

afterEach(()=>vi.restoreAllMocks());
it('keeps the complete language list while exposing only four executable local targets',async()=>{
  vi.spyOn(configuration,'readChannelSettings').mockResolvedValue({activeId:'local',profiles:[]});
  const connection=await definition.open({id:'local',adapterId:'shinobu',name:'Local',revision:1,settings:definition.defaultSettings!},{},()=>true);
  expect(connection.capabilities.languages).toEqual(fallbackLanguages);
  for(const language of fallbackLanguages){
    const supported=['zh-Hans','zh-Hant','ja','ko'].includes(language.id);
    expect(supportsLanguage(connection.capabilities,'classic',language.id)).toBe(supported);
    const html=renderToStaticMarkup(<TargetLanguage value={language.id} caps={connection.capabilities} onChange={()=>{}}/>);
    expect(html).toContain(`>${language.label}</span>`);
    expect(html.match(/nc-select-status/g)).toHaveLength(fallbackLanguages.length-4+(supported?0:1));
    expect(html.match(/role="option"/g)).toHaveLength(fallbackLanguages.length);
    // Pending options remain selectable; execution belongs to the adapter's admission policy.
    expect(html).not.toContain('aria-disabled="true"');
    const fonts=renderToStaticMarkup(<TranslationFontPicker language={language.id} selection={connection.fontSelection}/>);
    expect(!!fonts).toBe(supported);
  }
  expect(localLanguage('ja').pipeline).toBe('ja');expect(localLanguage('ko').pipeline).toBe('ko');
  connection.dispose();
});
it('preserves a named current selection when switching from a broader channel',()=>{
  const caps={modes:[{id:'classic' as const,label:'Local',enabled:true,languages:['zh-Hans']}],languages:fallbackLanguages.slice(0,1),limits:{max_bytes:1,max_pixels:1,max_dimension:1,max_translation_ids:1},entitlements:null};
  const html=renderToStaticMarkup(<TargetLanguage label="翻译目标语言" value="ko" caps={caps} onChange={()=>{}}/>);
  expect(html).toContain('>한국어</span>');expect(html).toContain('aria-label="한국어 · 待支持"');expect(html).toContain('data-value="ko"');
  expect(html).not.toContain('>ko</span>');
});
it('updates an open local channel in every UI language without changing its connection or preferences',async()=>{
  vi.spyOn(configuration,'readChannelSettings').mockResolvedValue({activeId:'local',profiles:[]});
  const write=vi.spyOn(configuration,'updateChannelSettings');
  const connection=await definition.open({id:'local',adapterId:'shinobu',name:'浏览器本地翻译',revision:1,settings:definition.defaultSettings!},{},()=>true);
  const {key,scope,capabilities,options}=connection,services=options!.services!;
  const previousLocale=getLocale(),previousDictionary=getDictionary();
  try{
    for(const {id} of uiLanguages){
      const dictionary=JSON.parse(readFileSync(new URL(`../../../../i18n/dictionaries/${id}.json`,import.meta.url),'utf8')) as Dictionary;
      installDictionary(id,dictionary);
      expect(connection.label,id).toBe(dictionary['浏览器本地翻译']);
      expect(definition.status,id).toBe(dictionary['测试版']);
      expect(capabilities.modes[0].label,id).toBe(dictionary['翻译']);
      expect(options!.settingsLabel,id).toBe(dictionary['本机识别设置']);
      expect(options!.fields[0].label,id).toBe(dictionary['运行方式']);
      expect(options!.fields[1].options?.find(item=>item.value==='off')?.label,id).toBe(dictionary['不启用']);
      expect(services.label,id).toBe(dictionary['正文翻译服务']);
      expect(services.addLabel,id).toBe(dictionary['添加 LLM 供应商']);
      expect(services.items[0].label,id).toBe(dictionary['谷歌翻译']);
      expect(services.items[0].description,id).toBe(dictionary['无需配置，使用 Google Translate 翻译正文。']);
      expect(connection.fontSelection!.description,id).toBe(dictionary['此字体用于本地译图嵌字，需先下载完整字库。更换后，新翻译或手动重译的页面使用新字体。']);
      expect(connection.key).toBe(key);expect(connection.scope).toBe(scope);
      expect(connection.capabilities).toBe(capabilities);expect(connection.options).toBe(options);
      expect(connection.isCurrent()).toBe(true);expect(services.selectedId).toBe('google');
    }
    expect(write).not.toHaveBeenCalled();
  }finally{installDictionary(previousLocale,previousDictionary);connection.dispose();}
});
