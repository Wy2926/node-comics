import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {uiLanguages,resolveLocale,matchLocale,type UiLocale} from '../src/i18n/locales';
import {installDictionary,msg,getLocale,messageSource,type Dictionary} from '../src/i18n/runtime';
import {translationNotice} from '../src/translation/notice';
import {defaults,modeLabels,statusLabels} from '../src/types';
import {settings,saveSettings} from '../src/library/store';
import {suggestedKind} from '../src/library/model';
import type {SourceEntry} from '../src/library/types';

const directory=new URL('../src/i18n/dictionaries/',import.meta.url);
const dictionaries=Object.fromEntries(readdirSync(directory).map(file=>[file.slice(0,-5),JSON.parse(readFileSync(new URL(file,directory),'utf8')) as Dictionary]));
const placeholders=(text:string)=>[...text.matchAll(/\{\w+\}/g)].map(m=>m[0]).sort();
afterEach(()=>{installDictionary('zh-CN',dictionaries['zh-CN']);vi.unstubAllGlobals();});

describe('interface dictionaries',()=>{
  it('ships exactly the requested 15 languages with identical keys and interpolation tokens',()=>{
    expect(Object.keys(dictionaries).sort()).toEqual(uiLanguages.map(l=>l.id).sort());
    const base=dictionaries['zh-CN'];
    for(const [locale,dict] of Object.entries(dictionaries)){
      expect(Object.keys(dict).sort(),locale).toEqual(Object.keys(base).sort());
      for(const [key,value] of Object.entries(dict)){
        expect(typeof value,`${locale}: ${key}`).toBe('string');
        expect(value.trim().length,`${locale}: ${key}`).toBeGreaterThan(0);
        expect(placeholders(value),`${locale}: ${key}`).toEqual(placeholders(base[key]));
      }
      expect([...dict['store.name']].length).toBeLessThanOrEqual(75);
      expect([...dict['store.description']].length).toBeLessThanOrEqual(132);
      expect(dict['brand.name']).toBe(locale==='zh-CN'?'NodeLane 漫译':locale==='zh-TW'?'NodeLane 漫譯':'NodeLane Comics');
    }
  });
  it('matches script/region variants and falls back without changing translation languages',()=>{
    expect(matchLocale('zh-Hant-HK')).toBe('zh-TW');expect(matchLocale('zh_SG')).toBe('zh-CN');
    expect(matchLocale('pt-PT')).toBe('pt-BR');expect(matchLocale('fr-CA')).toBe('fr');
    expect(resolveLocale('auto',['ko-KR','uk-UA'])).toBe('uk');expect(resolveLocale('auto',['ko-KR'])).toBe('en');
    expect(resolveLocale('ja',['en-US'])).toBe('ja');
  });
  it('persists UI language independently and rejects invalid saved preferences',async()=>{
    const saved=new Map<string,string>();
    vi.stubGlobal('localStorage',{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)});
    const input={...defaults,language:'ko',uiLanguage:'fr' as const};await saveSettings(input);
    expect(settings()).toMatchObject({uiLanguage:'fr',language:'ko',translationMode:defaults.translationMode});
    localStorage.setItem('nc-settings',JSON.stringify({...input,uiLanguage:'../outside'}));
    expect(settings()).toMatchObject({uiLanguage:'auto',language:'ko'});
  });
  it('refreshes module-level labels and keeps diagnostics and source parsing language-independent',()=>{
    for(const language of uiLanguages){
      installDictionary(language.id,dictionaries[language.id]);
      expect(modeLabels.classic).toBe(dictionaries[language.id]['常规翻译']);
      expect(statusLabels.failed).toBe(dictionaries[language.id]['处理失败']);
      const message=msg('暂时连接不到服务。请检查网络连接，原图仍可继续阅读。');
      expect(translationNotice({kind:'error',message}).message).toBe(msg('连接失败'));
      expect(messageSource(msg('第 {0} 页',{'0':123}))).toBe('第 {0} 页');
      expect(suggestedKind({rawTypes:['卷']} as SourceEntry)).toBe('publication');
      expect(suggestedKind({rawTypes:['番外']} as SourceEntry)).toBe('extra');
    }
  });
  it('interpolates data as plain text without evaluating it or processing embedded tokens',()=>{
    installDictionary('en',dictionaries.en);
    expect(msg('第 {0} 页',{'0':'<img onerror=alert(1)>{1}'})).toBe('Page <img onerror=alert(1)>{1}');
    installDictionary('fr',{});expect(msg('关闭')).toBe(dictionaries.en['关闭']);
  });
});

describe('locale loading',()=>{
  it('lets the last selection win and keeps the current locale when a dictionary fails',async()=>{
    vi.stubGlobal('location',{origin:'https://local.example'});
    const pending=new Map<string,(response:Response)=>void>();
    vi.stubGlobal('fetch',vi.fn((url:string)=>new Promise<Response>(resolve=>pending.set(url,resolve))));
    const {setUiLanguage}=await import('../src/i18n/load');
    const first=setUiLanguage('fr'),second=setUiLanguage('de');
    pending.get('https://local.example/i18n/de.json')!(Response.json(dictionaries.de));await second;
    pending.get('https://local.example/i18n/fr.json')!(Response.json(dictionaries.fr));await first;
    expect(getLocale()).toBe('de');
    const failed=setUiLanguage('it');pending.get('https://local.example/i18n/it.json')!(new Response('',{status:404}));
    await expect(failed).rejects.toThrow();expect(getLocale()).toBe('de');
    const retried=setUiLanguage('it');pending.get('https://local.example/i18n/it.json')!(Response.json(dictionaries.it));await retried;
    expect(getLocale()).toBe('it' satisfies UiLocale);
  });
});
