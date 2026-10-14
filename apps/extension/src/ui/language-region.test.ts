import {describe,expect,it} from 'vitest';
import {languageRegion} from './language-region';
import {uiLanguages} from '../i18n/locales';
import {fallbackLanguages,languageLabel,supportsLanguage} from '../types';
import regions from '../../public/flags/regions.json';

describe('language flag presentation',()=>{
  it('labels unspecified Chinese without adding a translation target',()=>{
    expect(languageLabel('zh')).toBe('中文');
    expect(languageLabel('zh-Hans')).toBe('简体中文');
    expect(languageLabel('zh-Hant')).toBe('繁體中文');
    expect(languageLabel('unknown')).toBe('unknown');
    expect(fallbackLanguages.some(language=>language.id==='zh')).toBe(false);
    expect(supportsLanguage(undefined,'classic','zh')).toBe(false);
    expect(supportsLanguage(undefined,'classic','zh-Hans')).toBe(true);
    expect(supportsLanguage(undefined,'classic','zh-Hant')).toBe(true);
  });
  it('covers every interface and translation language with a bundled flag',()=>{
    for(const {id} of [...uiLanguages,...fallbackLanguages])expect(regions).toContain(languageRegion(id)?.toLowerCase());
  });
  it.each([
    ['en-GB','GB'],['en-AU','AU'],['pt-PT','PT'],['pt_BR','BR'],['zh-HK','HK'],
    ['zh-Hant','TW'],['zh-Hans','CN'],['ja-Latn','JP'],['ko-Latn','KR'],['zh-Latn','CN'],
    ['hi','IN'],['bn','BD'],['fa','IR'],['he','IL'],['th','TH'],['fil','PH'],
    ['sw','TZ'],['am','ET'],['af','ZA'],['uk','UA'],['sr-Latn','RS'],['es-AR','AR'],
  ])('uses standard locale data for %s without a source-specific mapping',(language,region)=>{
    expect(languageRegion(language)).toBe(region);expect(regions).toContain(region.toLowerCase());
  });
  it.each(['auto','','invalid-language-tag','und','mul','zxx','eo','es-419','en-001'])('keeps %s neutral instead of inventing a country',language=>{
    expect(languageRegion(language)).toBeUndefined();
  });
});
