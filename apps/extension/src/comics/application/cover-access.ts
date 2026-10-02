import type {Comic} from '../domain';
import {catalog} from '../repositories';
import {pageReference, pageRenderProfile} from '../pages/identity';
import {detectFormat} from '../formats/identify';
import {readSourceCover} from '../../sources';
import type {SourceCatalog} from './types';
import {getSourceDriver} from '../sources/registry';

const prefix = 'source-cover:';
export const sourceCoverOwner = (comicId: string) => prefix + comicId;
export function coverReference(comic: Comic): string | undefined {
  if(comic.sourceArtwork)return prefix+JSON.stringify([comic.id,'provider',comic.sourceArtwork.id,String(comic.source.generation)]);
  if (comic.sourceCover) return prefix + JSON.stringify([comic.id, comic.sourceCover.url]);
  const name=typeof comic.source.locator.name==='string' ? comic.source.locator.name : '';
  return comic.cover ? pageReference({
    ...comic.cover,
    renderProfileId: pageRenderProfile(comic.cover.format ?? detectFormat(name) ?? 'website'),
  }) : undefined;
}
export async function openSourceCover(key: string) {
  if (!key.startsWith(prefix)) return;
  let reference: unknown;
  try {
    reference = JSON.parse(key.slice(prefix.length));
  } catch { /* Reject a malformed reference before accessing a source. */ }
  if (!Array.isArray(reference) || ![2,4].includes(reference.length) || reference.some(item => typeof item !== 'string' || !item))
    throw Error('封面引用无效。');
  const [comicId, url] = reference as [string, string];
  const comic = await catalog.get('comics', comicId);
  const connection = comic && await catalog.get('connections', comic.source.connectionId);
  if(reference.length===4){
    if(reference[1]!=='provider'||!comic||!connection||comic.source.status!=='active'||['disconnected','revoked'].includes(connection.status)||!comic.sourceArtwork||comic.sourceArtwork.id!==reference[2]||String(comic.source.generation)!==reference[3])throw Error('封面来源已变化，请重新打开漫画。');
    const artwork=comic.sourceArtwork,reader=getSourceDriver(connection.provider)?.artwork;
    if(!reader)throw Error('此来源不提供封面读取。');
    return {owner:sourceCoverOwner(comic.id),connectionId:connection.id,
      read:(signal?:AbortSignal)=>reader.read(connection,artwork,signal),
      async validate(){const [current,access]=await Promise.all([catalog.get('comics',comic.id),catalog.get('connections',connection.id)]);
        if(!current||current.source.status!=='active'||current.source.generation!==comic.source.generation||current.sourceArtwork?.id!==artwork.id||!access||access.generation!==connection.generation||['disconnected','revoked'].includes(access.status))throw Error('封面来源已变化，请重新打开漫画。');},
    };
  }
  const source = comic && await catalog.get('catalogs', comic.source.providerItemId) as SourceCatalog | undefined;
  if (!comic || comic.source.status !== 'active' || !connection || ['disconnected', 'revoked'].includes(connection.status) ||
      !source || source.comicId !== comic.id || comic.source.connectionId !== 'website:' + source.sourceId ||
      comic.sourceCover?.url !== url || source.cover?.url !== url)
    throw Error('封面来源已变化，请重新打开漫画。');
  return {
    owner: sourceCoverOwner(comic.id), connectionId: connection.id,
    read: (signal?: AbortSignal) => readSourceCover(source, signal),
    async validate() {
      const current = await catalog.get('comics', comic.id), access = await catalog.get('connections', connection.id);
      if (!current || current.source.status !== 'active' || current.source.generation !== comic.source.generation ||
          current.sourceCover?.url !== url || !access || access.generation !== connection.generation ||
          ['disconnected', 'revoked'].includes(access.status)) throw Error('封面来源已变化，请重新打开漫画。');
    },
  };
}
