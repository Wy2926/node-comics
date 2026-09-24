import type {Comic} from '../domain';
import {catalog} from '../repositories';
import {pageReference, RENDER_PROFILE} from '../pages/identity';
import {readSourceCover} from '../../sources';
import type {SourceCatalog} from './types';

const prefix = 'source-cover:';
export const sourceCoverOwner = (comicId: string) => prefix + comicId;
export function coverReference(comic: Comic): string | undefined {
  if (comic.sourceCover) return prefix + JSON.stringify([comic.id, comic.sourceCover.url]);
  return comic.cover ? pageReference({...comic.cover, renderProfileId: RENDER_PROFILE}) : undefined;
}
export async function openSourceCover(key: string) {
  if (!key.startsWith(prefix)) return;
  let reference: unknown;
  try {
    reference = JSON.parse(key.slice(prefix.length));
  } catch { /* Reject a malformed reference before accessing a source. */ }
  if (!Array.isArray(reference) || reference.length !== 2 || reference.some(item => typeof item !== 'string' || !item))
    throw Error('封面引用无效。');
  const [comicId, url] = reference as [string, string];
  const comic = await catalog.get('comics', comicId);
  const connection = comic && await catalog.get('connections', comic.source.connectionId);
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
