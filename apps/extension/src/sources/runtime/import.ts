import {resolveSource} from '../core/resolve';
import {definitions} from '../registry/definitions';
import {requestImagePermissions} from './permissions';

/** Call directly from the user gesture; permission requests must precede storage/network awaits. */
export async function authorizeCatalogImport(url:string) {
  const {definition,location}=resolveSource(url,definitions);
  if(!definition.capabilities.importable||!definition.capabilities.catalog||location.kind!=='catalog')throw Error('请粘贴已适配网站的漫画详情页链接。');
  await requestImagePermissions([new URL(location.url).origin+'/*',...(definition.installation.optionalOrigins??[])]);
  return {url:location.url,catalogId:location.catalog!.key};
}
