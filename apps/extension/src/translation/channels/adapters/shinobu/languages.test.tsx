import {afterEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {TargetLanguage} from '../../../../ui/TargetLanguage';
import {TranslationFontPicker} from '../../../../ui/TranslationFontPicker';
import {fallbackLanguages,supportsLanguage} from '../../../../types';
import * as configuration from '../../configuration';
import {definition} from './definition';
import {localLanguage} from './languages';

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
