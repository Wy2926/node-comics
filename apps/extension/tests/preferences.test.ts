import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaults } from '../src/types';
import { readSearchLanguage, readSearchSiteSelection, saveSearchLanguage, saveSearchSiteSelection, saveSettings, settings } from '../src/comics/application/preferences';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
it('accepts only listed search languages without converting unsupported values', () => {
  saveSearchLanguage('zh-Hant'); expect(readSearchLanguage('en')).toBe('zh-Hant');
  saveSearchLanguage('zh'); expect(localStorage.getItem('nc-search-language')).toBe('zh-Hant');
  localStorage.setItem('nc-search-language', 'zh'); expect(readSearchLanguage('en')).toBe('en');
  expect(localStorage.getItem('nc-search-language')).toBe('zh');
});
it('persists each search site choice, including an entirely deselected scope, independently of language settings', () => {
  expect(readSearchSiteSelection()).toEqual({});
  saveSearchSiteSelection('a:a', false); saveSearchSiteSelection('b:b', false);
  expect(readSearchSiteSelection()).toEqual({'a:a':false,'b:b':false});
  saveSearchLanguage('ja'); saveSearchSiteSelection('a:a', true);
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
  expect(readSearchSiteSelection()).toEqual({});expect(()=>saveSearchSiteSelection('a:a',false)).not.toThrow();
});
it('keeps known preferences while discarding old concurrency and backend overrides', async () => {
  localStorage.setItem('nc-settings', JSON.stringify({ requestConcurrency: 1, autoTranslate: true, apiBase: 'https://wrong.example', language: 'en' }));
  await saveSettings(settings());
  const stored = JSON.parse(localStorage.getItem('nc-settings')!);
  expect(stored.language).toBe('en');
  expect(stored).not.toHaveProperty('requestConcurrency'); expect(stored).not.toHaveProperty('apiBase'); expect(stored).not.toHaveProperty('autoTranslate');
});
it('preserves disabled/unlimited translation budgets and rejects malformed preferences', async () => {
  await saveSettings({ ...defaults, cacheLimitMb: 0 }); expect(settings().cacheLimitMb).toBe(0);
  await saveSettings({ ...defaults, cacheLimitMb: -1 }); expect(settings().cacheLimitMb).toBe(-1);
  localStorage.setItem('nc-settings', JSON.stringify({ cacheLimitMb: -999, textScale: -10 }));
  expect(settings()).toMatchObject({ cacheLimitMb: defaults.cacheLimitMb, textScale: 1 });
});
