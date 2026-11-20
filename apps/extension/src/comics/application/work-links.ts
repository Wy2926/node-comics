import type {Comic} from '../domain';
import {catalog} from '../repositories';
import {msg} from '../../i18n/runtime';

export function linkedWorkId(comic: Comic, providerId: string) {
  if (comic.workLinks && Object.hasOwn(comic.workLinks, providerId)) return comic.workLinks[providerId];
  if (comic.externalWorkIds && Object.hasOwn(comic.externalWorkIds, providerId)) return comic.externalWorkIds[providerId];
}

/** With no expected ID, an import can fill a missing link, never replace a conflicting link or an explicit unlink. */
export async function setWorkLink(comicId: string, providerId: string, workId: string | null, expected?: string | null) {
  return catalog.mutate(['comics'], async tx => {
    const comic = await tx.get('comics', comicId);
    if (!comic) throw Error(msg('漫画已移除。'));
    const current = linkedWorkId(comic, providerId);
    if (current !== workId && current !== expected) return false;
    if (comic.workLinks && Object.hasOwn(comic.workLinks, providerId) && comic.workLinks[providerId] === workId) return true;
    await tx.put('comics', {...comic, workLinks: {...comic.workLinks, [providerId]: workId}});
    return true;
  });
}
