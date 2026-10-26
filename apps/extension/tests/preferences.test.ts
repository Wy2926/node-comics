import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaults } from '../src/types';
import {normalizeReaderZoom} from '../src/reader/view';
import { readSearchLanguage, readSearchSiteSelection, saveSearchLanguage, saveSearchSiteSelection, saveSettings, settings, readSiteFavorites, saveSiteFavorites, siteFavoritesKey } from '../src/comics/application/preferences';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
it('persists and removes site favorites independently of search scope and reader settings', () => {
  saveSearchSiteSelection({'a:a': false});
  expect(readSiteFavorites()).toEqual([]);
  saveSiteFavorites(['a:a', 'b:b', 'a:a']);
  expect(readSiteFavorites()).toEqual(['a:a', 'b:b']);
  saveSiteFavorites(['b:b']); expect(readSiteFavorites()).toEqual(['b:b']);
  saveSiteFavorites([]); expect(readSiteFavorites()).toEqual([]);
  expect(readSearchSiteSelection()).toEqual({'a:a': false});
  expect(localStorage.getItem('nc-settings')).toBeNull();
});
it('rejects malformed favorite lists and tolerates unavailable storage', () => {
  for (const value of ['null', '{}', 'broken', '"a:a"']) {
    localStorage.setItem(siteFavoritesKey, value); expect(readSiteFavorites()).toEqual([]);
  }
  localStorage.setItem(siteFavoritesKey, JSON.stringify(['a:a', 1, null, '', 'a:a', 'b:b']));
  expect(readSiteFavorites()).toEqual(['a:a', 'b:b']);
  vi.stubGlobal('localStorage', {getItem: () => {throw Error('blocked');}, setItem: () => {throw Error('blocked');}});
  expect(readSiteFavorites()).toEqual([]);
  expect(() => saveSiteFavorites(['a:a'])).not.toThrow();
});
it('accepts only listed search languages without converting unsupported values', () => {
  saveSearchLanguage('zh-Hant'); expect(readSearchLanguage('en')).toBe('zh-Hant');
  saveSearchLanguage('zh'); expect(localStorage.getItem('nc-search-language')).toBe('zh-Hant');
  localStorage.setItem('nc-search-language', 'zh'); expect(readSearchLanguage('en')).toBe('en');
  expect(localStorage.getItem('nc-search-language')).toBe('zh');
});
it('persists each search site choice, including an entirely deselected scope, independently of language settings', () => {
  expect(readSearchSiteSelection()).toEqual({});
  saveSearchSiteSelection({'a:a':false}); saveSearchSiteSelection({'b:b':false});
  expect(readSearchSiteSelection()).toEqual({'a:a':false,'b:b':false});
  saveSearchLanguage('ja'); saveSearchSiteSelection({'a:a':true});
  expect(readSearchSiteSelection()).toEqual({'a:a':true,'b:b':false});
  expect(readSearchLanguage('en')).toBe('ja');
  expect(localStorage.getItem('nc-settings')).toBeNull();
});
it('recovers search scope from malformed or unavailable optional preference storage', () => {
  for(const value of ['null','[]','broken','"a:a"']){
    localStorage.setItem('nc-search-sites',value);expect(readSearchSiteSelection()).toEqual({});
  }
  localStorage.setItem('nc-search-sites',JSON.stringify({'a:a':false,'b:b':'false','c:c':true}));
  expect(readSearchSiteSelection()).toEqual({'a:a':false,'c:c':true});
  vi.stubGlobal('localStorage',{getItem:()=>{throw Error('unavailable');},setItem:()=>{throw Error('unavailable');}});
  expect(readSearchSiteSelection()).toEqual({});expect(()=>saveSearchSiteSelection({'a:a':false})).not.toThrow();
});
it('saves a filtered batch with one storage read and write while preserving hidden choices', () => {
  saveSearchSiteSelection({'hidden:hidden':false});
  const read=vi.spyOn(localStorage,'getItem'),write=vi.spyOn(localStorage,'setItem');
  const selection=Object.fromEntries(Array.from({length:44},(_,index)=>['site:'+index,index%2===0]));
  saveSearchSiteSelection(selection);
  expect(read).toHaveBeenCalledTimes(1);expect(write).toHaveBeenCalledTimes(1);
  expect(readSearchSiteSelection()).toEqual({'hidden:hidden':false,...selection});
});
it('keeps known preferences while discarding old concurrency and backend overrides', async () => {
  localStorage.setItem('nc-settings', JSON.stringify({ requestConcurrency: 1, autoTranslate: true, apiBase: 'https://wrong.example', translationMode:'unsupported', language: 'en' }));
  await saveSettings(settings());
  const stored = JSON.parse(localStorage.getItem('nc-settings')!);
  expect(stored.language).toBe('en');
  expect(stored).not.toHaveProperty('requestConcurrency'); expect(stored).not.toHaveProperty('apiBase'); expect(stored).not.toHaveProperty('autoTranslate');
  expect(stored).not.toHaveProperty('translationMode');
});
it('preserves disabled/unlimited translation budgets and rejects malformed preferences', async () => {
  await saveSettings({ ...defaults, cacheLimitMb: 0 }); expect(settings().cacheLimitMb).toBe(0);
  await saveSettings({ ...defaults, cacheLimitMb: -1 }); expect(settings().cacheLimitMb).toBe(-1);
  localStorage.setItem('nc-settings', JSON.stringify({ cacheLimitMb: -999, textScale: -10, translationMode:'unsupported' }));
  expect(settings()).toMatchObject({ cacheLimitMb: defaults.cacheLimitMb, textScale: 1 });
  expect(settings()).not.toHaveProperty('translationMode');
});
it('persists all reader layouts, including double-page reading, across reloads', async () => {
  for (const layout of ['continuous', 'single', 'double'] as const) {
    await saveSettings({...defaults, layout});
    expect(settings().layout).toBe(layout);
  }
  for (const layout of ['spread', '', 2, null]) {
    localStorage.setItem('nc-settings', JSON.stringify({layout}));
    expect(settings().layout).toBe(defaults.layout);
  }
});
it.each([false,true])('resolves an unset zoom on the reading device and persists an explicit global choice (touch: %s)',async touch=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:touch})});
  expect(normalizeReaderZoom(settings().readerZoom)).toBe(touch?100:50);
  localStorage.setItem('nc-settings',JSON.stringify({language:'ja'}));
  expect(normalizeReaderZoom(settings().readerZoom)).toBe(touch?100:50);
  for(const readerZoom of [40,70,100,130,200]){
    await saveSettings({...settings(),readerZoom});
    expect(settings().readerZoom).toBe(readerZoom);
    expect(JSON.parse(localStorage.getItem('nc-settings')!).readerZoom).toBe(readerZoom);
  }
  for(const readerZoom of [null,'150',39,201,155,{},true]){
    localStorage.setItem('nc-settings',JSON.stringify({language:'ja',readerZoom}));
    expect(normalizeReaderZoom(settings().readerZoom)).toBe(touch?100:50);
    expect(settings().language).toBe('ja');
  }
});
it('mirrors double-page reading to trusted extension settings and reader preferences', async () => {
  const set = vi.fn(async () => {});
  vi.stubGlobal('chrome', {storage: {local: {get: vi.fn(async () => ({})), set}}});
  await saveSettings({...defaults, layout: 'double'});
  expect(set).toHaveBeenCalledWith({'nc-reader-settings': {...defaults, layout: 'double'}});
  expect(set).toHaveBeenCalledWith({preferences: {language: defaults.language, direction: defaults.direction, layout: 'double', fit: defaults.fit}});
  expect(settings().layout).toBe('double');
});
it('enables discovery text translation by default and preserves the saved choice across reloads', async () => {
  expect(defaults.discoveryTextTranslation).toBe(true);
  expect(settings().discoveryTextTranslation).toBe(true);
  localStorage.setItem('nc-settings',JSON.stringify({uiLanguage:'auto',language:'ja'}));
  expect(settings()).toMatchObject({discoveryTextTranslation:true,uiLanguage:'auto',language:'ja'});
  await saveSettings({...settings(),discoveryTextTranslation:false});
  expect(JSON.parse(localStorage.getItem('nc-settings')!).discoveryTextTranslation).toBe(false);
  expect(settings()).toMatchObject({discoveryTextTranslation:false,uiLanguage:'auto',language:'ja'});
  await saveSettings({...settings(),discoveryTextTranslation:true});
  expect(settings().discoveryTextTranslation).toBe(true);
});
it('recovers malformed discovery text translation values to the enabled default', () => {
  for(const value of ['false',0,1,null,{},[]]) {
    localStorage.setItem('nc-settings',JSON.stringify({discoveryTextTranslation:value}));
    expect(settings().discoveryTextTranslation).toBe(true);
  }
});
