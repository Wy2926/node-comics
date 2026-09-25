import {describe,expect,it} from 'vitest';
import {languageRegion} from './language-region';
import {uiLanguages} from '../i18n/locales';
import {fallbackLanguages} from '../types';
import regions from '../../public/flags/regions.json';

describe('language flag presentation',()=>{
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
