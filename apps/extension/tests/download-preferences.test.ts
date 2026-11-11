import 'fake-indexeddb/auto';
import {beforeEach,expect,it} from 'vitest';
import type {Comic} from '../src/comics/domain';
import {catalog} from '../src/comics/repositories';
import {bookDownloadSource} from '../src/comics/acquisition/book-model';
import {defaultDownloadSettings,downloadConcurrencyLimit,downloadSettingsId,readDownloadSettings,saveDownloadConcurrency} from '../src/comics/acquisition/preferences';

const comic=(url:string):Pick<Comic,'source'|'sourceUrl'>=>({sourceUrl:url,source:{connectionId:'website:fixture',providerItemId:'book',locator:{},generation:1,status:'active'}});
beforeEach(async()=>{await catalog.put('metadata',{id:downloadSettingsId,...defaultDownloadSettings});});

it('uses adapter-declared automatic concurrency and a shared fallback without inferring a remote library site',()=>{
  const comix=comic('https://comix.to/title/test'),unknown=comic('https://fixture.test/comic');
  expect(downloadConcurrencyLimit(defaultDownloadSettings,comix)).toBe(2);
  expect(downloadConcurrencyLimit(defaultDownloadSettings,unknown)).toBe(3);
  expect(downloadConcurrencyLimit({...defaultDownloadSettings,concurrency:6},comix)).toBe(6);
  expect(downloadConcurrencyLimit(defaultDownloadSettings,{...comix,source:{...comix.source,connectionId:'opds:fixture'}})).toBe(3);
  expect(downloadConcurrencyLimit(defaultDownloadSettings,{...comix,sourceUrl:undefined,source:{...comix.source,locator:{url:comix.sourceUrl}}})).toBe(2);
});

it('merges concurrent per-origin and global choices, then resets only the chosen site to the current default',async()=>{
  const a=comic('https://a.test/comic'),b=comic('https://b.test/comic'),other=comic('https://other.test/comic');
  const keyA=bookDownloadSource(a),keyB=bookDownloadSource(b);
  await Promise.all([saveDownloadConcurrency(1,keyA),saveDownloadConcurrency(4,keyB),saveDownloadConcurrency(6)]);
  let saved=await readDownloadSettings();
  expect(saved).toEqual({concurrency:6,sites:{[keyA]:1,[keyB]:4}});
  expect([a,b,other].map(comic=>downloadConcurrencyLimit(saved,comic))).toEqual([1,4,6]);
  await saveDownloadConcurrency('auto',keyA);saved=await readDownloadSettings();
  expect(saved.sites).toEqual({[keyB]:4});
  expect([a,b,other].map(comic=>downloadConcurrencyLimit(saved,comic))).toEqual([6,4,6]);
  await saveDownloadConcurrency('auto');saved=await readDownloadSettings();
  expect([a,b,other].map(comic=>downloadConcurrencyLimit(saved,comic))).toEqual([3,4,3]);
});

it('reads earlier global settings and discards malformed site overrides',async()=>{
  await catalog.put('metadata',{id:downloadSettingsId,concurrency:4});
  expect(await readDownloadSettings()).toEqual({concurrency:4,sites:{}});
  await catalog.put('metadata',{id:downloadSettingsId,concurrency:99,sites:{valid:2,negative:-1,huge:99,decimal:1.5,text:'4',auto:'auto'}});
  expect(await readDownloadSettings()).toEqual({concurrency:'auto',sites:{valid:2}});
});
