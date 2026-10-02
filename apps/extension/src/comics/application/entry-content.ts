import { catalog } from '../repositories';
import { entryContentKind, type Entry } from '../domain';
import { requireSourceDriver } from '../sources/registry';
import { descriptors, publishIndex, reindexEntry } from './import-service';
import { discoverWebsiteContent } from './website-content';
import { sourcePageCache } from '../../storage/source-pages';
import { sourceRangeCache } from '../../storage/source-ranges';
import { thumbnailCache } from '../../storage/thumbnails';
import { downloadStore } from '../../storage/downloads';
import { reloadRemoteEntry } from './remote-library-service';

export { entryContentKind } from '../domain';
export interface PrepareEntryOptions {
  reload?: boolean;
  refreshResources?: boolean;
  /** An acquisition caller may reuse an inventory it just verified for this exact content. */
  retainedPages?: { contentId: string; count: number };
}
const stale = () => new DOMException('漫画已移除或来源内容已变化。', 'AbortError');

/** Content representation determines indexing; the connection provider owns resource acquisition. */
export async function prepareEntryContent(
  id: string,
  signal?: AbortSignal,
  { reload = false, refreshResources = false, retainedPages }: PrepareEntryOptions = {},
): Promise<void> {
  signal?.throwIfAborted();
  const entry = await catalog.get('entries', id);
  if (!entry) throw Error('文档已移除。');
  if (reload && (await reloadRemoteEntry(id, signal))) return;
  if (entryContentKind(entry) === 'file') {
    if (reload) await reindexEntry(id, signal);
    return;
  }
  if (!reload && !refreshResources && entry.discoveryComplete) return;
  if (!reload && entry.discoveryComplete && entry.pageCount) {
    const count =
      retainedPages?.contentId === entry.contentId
        ? retainedPages.count
        : (await downloadStore.inventory([entry.id], true)).filter(
            (page) => page.contentId === entry.contentId,
          ).length;
    if (
      count === entry.pageCount &&
      (entry.knownTotal === undefined || entry.knownTotal === entry.pageCount)
    )
      return;
  }
  if (entry.sourceRemoved || entry.readable === false)
    throw Error('源站此章节暂不可读，已保存的页面仍可阅读。');
  // Preserve the established website discovery and document-authorization path.
  if (entry.format === 'website') {
    if (entry.discoveryComplete && !reload && refreshResources) {
      const pages = await catalog.listPages(entry.contentId, { limit: 1500 });
      if (!pages.some((page) => typeof page.locator.contentKey === 'string')) return;
    }
    await discoverWebsiteContent(entry, signal, reload);
    return;
  }
  await prepareProviderPages(entry, signal, reload);
}

async function prepareProviderPages(
  entry: Entry,
  signal: AbortSignal | undefined,
  reload: boolean,
) {
  const comic = await catalog.get('comics', entry.comicId),
    connection = comic && (await catalog.get('connections', comic.source.connectionId));
  if (
    !comic ||
    !connection ||
    comic.source.status !== 'active' ||
    ['disconnected', 'revoked'].includes(connection.status)
  )
    throw Error('来源访问已断开，请重新连接。');
  const provider = requireSourceDriver(connection.provider);
  if (!provider.pages) throw Error('此来源不提供逐页读取。');
  const assertCurrent = async () => {
    signal?.throwIfAborted();
    const [current, owner, access] = await Promise.all([
      catalog.get('entries', entry.id),
      catalog.get('comics', comic.id),
      catalog.get('connections', connection.id),
    ]);
    if (
      !current ||
      current.contentId !== entry.contentId ||
      current.generation !== entry.generation ||
      !owner ||
      owner.source.status !== 'active' ||
      owner.source.generation !== comic.source.generation ||
      !access ||
      access.generation !== connection.generation ||
      ['disconnected', 'revoked'].includes(access.status)
    )
      throw stale();
  };
  const result = await provider.pages.index({
    connection,
    source: comic.source,
    entryId: entry.id,
    contentId: entry.contentId,
    sourceSnapshot: entry.sourceSnapshot,
    format: entry.format,
    entry,
    signal,
  });
  if (
    !result.complete ||
    !result.pages.length ||
    result.pages.length > 1500 ||
    (result.total !== undefined && result.total !== result.pages.length) ||
    result.pages.some((page, index) => page.ordinal !== index)
  )
    throw Error('来源没有有效的完整页面索引。');
  await assertCurrent();
  const previous = await catalog.listPages(entry.contentId, { limit: 1500 }),
    incoming = descriptors(entry.contentId, result.pages);
  if (new Set(incoming.map((page) => page.pageId)).size !== incoming.length)
    throw Error('来源页面身份重复。');
  const changed =
    previous.length !== incoming.length ||
    previous.some((page, index) => page.pageId !== incoming[index]?.pageId);
  if (changed && previous.length) {
    if (!reload) throw Error('来源内容已变化，请重新载入当前内容。');
    const contentId = crypto.randomUUID();
    await catalog.replaceContent(
      entry.id,
      entry.generation,
      { contentId, format: entry.format, sourceSnapshot: entry.sourceSnapshot },
      descriptors(contentId, result.pages),
      true,
      result.total,
    );
    await Promise.all([
      sourcePageCache.deleteOwner(entry.id),
      sourceRangeCache.deleteOwner(entry.id),
      thumbnailCache.deleteOwner(entry.id),
      downloadStore.deleteOwner(entry.id),
    ]);
  } else await publishIndex(entry, result.pages, true, result.total);
}
