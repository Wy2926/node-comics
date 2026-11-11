import {catalog} from '../repositories';
import type {Comic} from '../domain';
import {sourceFor} from '../../sources';
import {bookDownloadSource} from './book-model';

export const downloadSettingsId='download-settings';
export const downloadConcurrencyOptions=[1,2,3,4,6] as const;
export type DownloadConcurrency='auto'|typeof downloadConcurrencyOptions[number];
export interface DownloadSettings {concurrency:DownloadConcurrency;sites:Record<string,Exclude<DownloadConcurrency,'auto'>>;}
export const defaultDownloadSettings:DownloadSettings={concurrency:'auto',sites:{}};
const normalize=(value:unknown):DownloadConcurrency=>downloadConcurrencyOptions.includes(value as typeof downloadConcurrencyOptions[number])?value as DownloadConcurrency:'auto';
function settings(record?:Record<string,unknown>):DownloadSettings{
  const stored=record?.sites;
  const sites=stored&&typeof stored==='object'&&!Array.isArray(stored)?Object.fromEntries(Object.entries(stored).filter(([,value])=>normalize(value)!=='auto')):{};
  return {concurrency:normalize(record?.concurrency),sites};
}
export function downloadConcurrencyLimit(preferences:DownloadSettings,comic?:Pick<Comic,'source'|'sourceUrl'>):number{
  const override=comic?normalize(preferences.sites[bookDownloadSource(comic)]):'auto';
  const value=override==='auto'?preferences.concurrency:override;
  if(value!=='auto')return value;
  const url=comic?.sourceUrl??comic?.source.locator.url;
  if(comic?.source.connectionId.startsWith('website:')&&typeof url==='string'){
    try{
      const declared=sourceFor(url).definition.downloadConcurrency;
      if(typeof declared==='number'&&Number.isSafeInteger(declared)&&declared>0)return Math.min(6,declared);
    }catch{/* Unrecognized or older source URLs use the global automatic default. */}
  }
  return 3;
}
export async function readDownloadSettings():Promise<DownloadSettings>{
  return settings(await catalog.get('metadata',downloadSettingsId));
}
/** Site overrides and the global choice merge atomically across extension pages. */
export async function saveDownloadConcurrency(value:DownloadConcurrency,source?:string):Promise<void>{
  await catalog.mutate(['metadata'],async tx=>{
    const current=settings(await tx.get('metadata',downloadSettingsId)),selection=normalize(value);
    if(source===undefined)current.concurrency=selection;
    else if(selection==='auto')delete current.sites[source];
    else current.sites={...current.sites,[source]:selection};
    await tx.put('metadata',{id:downloadSettingsId,...current});
  });
}
