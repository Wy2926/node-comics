import {resolveSource} from '../core/resolve';
import {definitions} from '../registry/definitions';
import {requireHostAccess} from '../../host-permissions';
import {resolveNetworkCatalog} from './network';
import {readSourceCatalog} from './catalog-reader';
import {sameSource} from '../core/identity';
import {validateCatalog} from '../core/catalog';
import {forgetImportResponses} from './import-responses';
import type {SourceCatalogSnapshot} from '../contracts/source';

/** Every import entry point resolves a reader to its work before the application creates records. */
export async function readImportCatalog(url:string,readCatalog:(url:string)=>Promise<SourceCatalogSnapshot>=readSourceCatalog){
  const {definition,location}=resolveSource(url,definitions);
  if(!definition.capabilities.importable||!definition.capabilities.catalog||location.kind==='other')throw Error('SOURCE_CATALOG_UNSUPPORTED');
  try{
    const target=location.kind==='catalog'?location.url:await resolveNetworkCatalog(location.url);
    if(!target)throw Error('无法确定章节所属漫画，请使用作品详情页链接。');
    const parent=resolveSource(target,definitions).location;
    const catalog=validateCatalog(await readCatalog(target),definitions);
    if(catalog.sourceId!==definition.id||catalog.id!==parent.catalog?.key||!catalog.complete||catalog.groups.some(group=>!group.complete))throw Error('SOURCE_CATALOG_CHANGED');
    if(location.kind==='reader'){
      const current=catalog.entries.find(entry=>sameSource(entry.url,location.url,definitions));
      // A bound parent cannot turn a missing requested release into another chapter.
      if(!current||current.related)throw Error('源站目录未包含指定章节，无法打开当前发布条目。');
    }
    return catalog;
  }catch(error){await forgetImportResponses(location);throw error;}
}

/** Validate a catalog entry and installation access before reading source data. */
export async function prepareCatalogImport(url:string) {
  const {definition,location}=resolveSource(url,definitions);
  if(!definition.capabilities.importable||!definition.capabilities.catalog||location.kind==='other')throw Error('请粘贴已适配网站的漫画详情页或章节链接。');
  await requireHostAccess();
  return location.url;
}
