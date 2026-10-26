import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {settings,saveSettings} from '../src/comics/application/preferences';
import {connectReaderSettings,initialReaderSettings,readReaderSettings,settingsKey,translationLanguageChanged} from '../src/inline/settings';
import {defaults,languageLabels} from '../src/types';
import {normalizeReaderZoom} from '../src/reader/view';

let local:Map<string,string>,stored:Record<string,unknown>;
let get:ReturnType<typeof vi.fn>,set:ReturnType<typeof vi.fn>;
const browserLanguages=(languages:string[])=>Object.assign(navigator,{languages,language:languages[0]});
beforeEach(()=>{
  local=new Map();stored={};
  let pending=Promise.resolve();
  vi.stubGlobal('navigator',{languages:['en-US'],locks:{request:vi.fn((_key:string,run:()=>Promise<unknown>)=>{
    const result=pending.then(run);pending=result.then(()=>{},()=>{});return result;
  })}});
  vi.stubGlobal('localStorage',{getItem:(key:string)=>local.get(key)??null,setItem:(key:string,value:string)=>local.set(key,value),removeItem:(key:string)=>local.delete(key)});
  get=vi.fn(async()=>structuredClone(stored));
  set=vi.fn(async(values:Record<string,unknown>)=>{Object.assign(stored,structuredClone(values));});
  vi.stubGlobal('chrome',{storage:{local:{get,set,setAccessLevel:vi.fn(async()=>{})},onChanged:{addListener:vi.fn()}}});
});
afterEach(()=>vi.unstubAllGlobals());

it.each([
  ['zh-CN','zh-Hans'],['zh-SG','zh-Hans'],['zh','zh-Hans'],['zh-Hans','zh-Hans'],
  ['zh-TW','zh-Hant'],['zh-HK','zh-Hant'],['zh-MO','zh-Hant'],['zh-Hant-HK','zh-Hant'],
  ['en-US','en'],['ja-JP','ja'],['ko_KR','ko'],['fr-CA','fr'],['es-MX','es'],['pt-PT','pt-BR'],['pt-BR','pt-BR'],
  ['de-DE','de'],['it-IT','it'],['ru-RU','ru'],['pl-PL','pl'],['uk-UA','uk'],['tr-TR','tr'],['vi-VN','vi'],['id-ID','id'],
])('initializes and saves browser language %s as %s',async(browser,expected)=>{
  browserLanguages([browser]);
  expect(settings().language).toBe(expected);
  await connectReaderSettings(settings());
  expect(settings().language).toBe(expected);
  expect(stored[settingsKey]).toEqual({...defaults,language:expected});
  expect(languageLabels[expected]).toBeTruthy();
  expect(set).toHaveBeenCalledTimes(1);
});
it.each([
  [['ar-SA','fr-CA','en-US'],'fr'],[['ja-JP','zh-TW'],'ja'],[['ar-SA'],'en'],[[],'en'],
])('uses the first supported browser preference or English: %j',async(languages,expected)=>{
  browserLanguages(languages as string[]);
  expect((await readReaderSettings()).language).toBe(expected);
});
it('falls back to English without a browser navigator',()=>{
  vi.stubGlobal('navigator',undefined);
  expect(initialReaderSettings().language).toBe('en');
});
it('persists first-use initialization in the standalone reader preview too',async()=>{
  vi.stubGlobal('chrome',undefined);browserLanguages(['ja-JP']);
  await connectReaderSettings(settings());
  browserLanguages(['de-DE']);await connectReaderSettings(settings());
  expect(settings().language).toBe('ja');
  expect(set).not.toHaveBeenCalled();
});
it('retains initialization across reopen and browser or interface language changes',async()=>{
  browserLanguages(['zh-TW']);await connectReaderSettings(settings());
  browserLanguages(['de-DE']);await connectReaderSettings(settings());
  expect(settings().language).toBe('zh-Hant');
  await saveSettings({...settings(),uiLanguage:'ja'});
  expect(settings()).toMatchObject({language:'zh-Hant',uiLanguage:'ja'});
  expect(set).toHaveBeenCalledTimes(3); // Initial record, UI preference, reader projection.
});
it.each(['zh-Hans','zh-Hant','ja','de'])('does not rewrite an existing extension preference: %s',async language=>{
  const previous={...defaults,language,uiLanguage:'ko',layout:'double',textScale:1.25};
  stored[settingsKey]=previous;
  local.set('nc-settings',JSON.stringify({...defaults,language:'fr'}));
  await connectReaderSettings(settings());
  expect(settings()).toEqual(previous);
  expect(stored[settingsKey]).toEqual(previous);
  expect(set).not.toHaveBeenCalled();
});
it('preserves local-only existing preferences when connecting them for the first time',async()=>{
  const previous={...defaults,language:'ja',accentTheme:'rose'};
  local.set('nc-settings',JSON.stringify(previous));
  await connectReaderSettings(settings());
  expect(settings()).toEqual(previous);
  expect(stored[settingsKey]).toEqual(previous);
});
it('retains the legacy default for existing records that omit the language',async()=>{
  local.set('nc-settings',JSON.stringify({uiLanguage:'ja',textScale:1.25}));
  expect(settings()).toMatchObject({language:'zh-Hans',uiLanguage:'ja',textScale:1.25});
  stored[settingsKey]={uiLanguage:'fr',layout:'double'};
  await connectReaderSettings(settings());
  expect(settings()).toMatchObject({language:'zh-Hans',uiLanguage:'fr',layout:'double'});
  expect(stored[settingsKey]).toEqual({uiLanguage:'fr',layout:'double'});
  expect(set).not.toHaveBeenCalled();
});
it('remembers a manual selection for both extension pages and background translation',async()=>{
  await connectReaderSettings(settings());
  await saveSettings({...settings(),language:'ko'});
  local.clear();browserLanguages(['fr-FR']);
  await connectReaderSettings(settings());
  expect(settings().language).toBe('ko');
  expect((await readReaderSettings()).language).toBe('ko');
  expect(stored.preferences).toMatchObject({language:'ko'});
});
it.each([true,false])('remembers immersive mode through local and extension restoration: %s',async readerImmersive=>{
  const previous={...defaults,language:'ja',layout:'single' as const,direction:'rtl' as const,readerBackground:'night' as const};
  await saveSettings({...previous,readerImmersive});
  expect(settings()).toEqual({...previous,readerImmersive});
  local.clear();
  await connectReaderSettings(settings());
  expect(settings()).toEqual({...previous,readerImmersive});
  expect((await readReaderSettings()).readerImmersive).toBe(readerImmersive);
  expect(translationLanguageChanged(previous,settings())).toBe(false);
});
it.each([undefined,null,'false',0,{}])('defaults only a missing or invalid immersive preference without resetting other choices: %j',readerImmersive=>{
  const previous={language:'ja',layout:'double',direction:'rtl',readerBackground:'night',readerImmersive};
  local.set('nc-settings',JSON.stringify(previous));
  expect(settings()).toMatchObject({...previous,readerImmersive:true});
  expect(JSON.parse(local.get('nc-settings')!)).toEqual(JSON.parse(JSON.stringify(previous)));
});
it('reads saved translation settings with one storage request and no write lock',async()=>{
  stored[settingsKey]={...defaults,language:'ja'};
  expect((await readReaderSettings()).language).toBe('ja');
  expect(get).toHaveBeenCalledExactlyOnceWith([settingsKey]);
  expect(set).not.toHaveBeenCalled();expect(navigator.locks.request).not.toHaveBeenCalled();
});
it('initializes a background-first entry once and shares it with the popup and reader',async()=>{
  browserLanguages(['ja-JP']);
  const results=await Promise.all([readReaderSettings(),readReaderSettings(),readReaderSettings()]);
  expect(results.map(value=>value.language)).toEqual(['ja','ja','ja']);
  expect(set).toHaveBeenCalledTimes(1);
  browserLanguages(['en-US']);await connectReaderSettings(settings());
  expect(settings().language).toBe('ja');
  expect(set).toHaveBeenCalledTimes(1);
});
it('leaves device zoom unresolved in the background and mirrors the explicit reader choice',async()=>{
  vi.stubGlobal('window',undefined);
  expect((await readReaderSettings()).readerZoom).toBeUndefined();
  vi.stubGlobal('window',{matchMedia:()=>({matches:true})});
  await connectReaderSettings(settings());
  expect(normalizeReaderZoom(settings().readerZoom)).toBe(100);
  await saveSettings({...settings(),readerZoom:140});
  local.clear();
  vi.stubGlobal('window',{matchMedia:()=>({matches:false})});
  await connectReaderSettings(settings());
  expect(settings().readerZoom).toBe(140);
  expect((await readReaderSettings()).readerZoom).toBe(140);
});
it.each([true,false])('never overwrites a concurrent manual save with initialization (initialize first: %s)',async initializeFirst=>{
  const manual={...defaults,language:'fr'};
  const initialize=()=>connectReaderSettings(initialReaderSettings());
  const save=()=>saveSettings(manual);
  await Promise.all(initializeFirst?[initialize(),save()]:[save(),initialize()]);
  await connectReaderSettings(settings());
  expect(settings().language).toBe('fr');
  expect(stored[settingsKey]).toEqual(manual);
});
it('keeps a newer saved choice when the initial settings read finishes late',async()=>{
  const previous={...defaults,language:'ja'},next={...defaults,language:'fr'};
  let finish!:(value:Record<string,unknown>)=>void;
  get.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  stored[settingsKey]=previous;
  const loading=connectReaderSettings(settings());
  await vi.waitFor(()=>expect(get).toHaveBeenCalledOnce());
  stored[settingsKey]=next;local.set('nc-settings',JSON.stringify(next));
  const notify=vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
  notify({[settingsKey]:{oldValue:previous,newValue:next}},'local');
  finish({[settingsKey]:previous});await loading;
  expect(settings().language).toBe('fr');expect(stored[settingsKey]).toEqual(next);
  expect(set).not.toHaveBeenCalled();
});
it('does not mistake initialization for a change that invalidates the first translation',()=>{
  const initial=initialReaderSettings();
  expect(translationLanguageChanged(undefined,initial)).toBe(false);
  expect(translationLanguageChanged(initial,{...initial,language:'ja'})).toBe(true);
  expect(translationLanguageChanged({uiLanguage:'en'},defaults)).toBe(false);
});
it('does not reset existing data when preference storage fails',async()=>{
  const previous={...defaults,language:'ja'};stored[settingsKey]=previous;
  get.mockRejectedValueOnce(Error('unavailable'));
  await expect(readReaderSettings()).rejects.toThrow('unavailable');
  expect(set).not.toHaveBeenCalled();expect(stored[settingsKey]).toEqual(previous);
});
it('keeps legacy recovery behavior for corrupt or unreadable local preferences',()=>{
  local.set('nc-settings','broken');expect(settings()).toEqual(defaults);
  vi.stubGlobal('localStorage',{getItem:()=>{throw Error('unavailable');}});
  expect(settings()).toEqual(defaults);
});
