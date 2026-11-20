import {sourceNetworks} from '../registry/networks';
import {definitions} from '../registry/definitions';
import {resolveSource} from '../core/resolve';
import {createSourceNetworkContext} from './http';

/** Resolve the saved release, never infer an episode from its title, order or reading slot. */
export function chapterDiscussion(url: string, entryId: string, catalogId: string) {
  let source: ReturnType<typeof resolveSource>;
  try {source = resolveSource(url, definitions);} catch {return;}
  const {definition, location} = source, adapter = sourceNetworks[definition.id]?.chapterComments;
  if (!adapter || location.kind !== 'reader' || location.pageKey !== entryId || location.catalog?.key !== catalogId) return;
  return {key: entryId, label: definition.name, url: location.url, async read(cursor: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    const {request} = createSourceNetworkContext(signal, [], adapter.headers ?? {});
    const page = await adapter.read(location.url, cursor, target => request(target));
    signal.throwIfAborted();
    return page;
  }};
}
