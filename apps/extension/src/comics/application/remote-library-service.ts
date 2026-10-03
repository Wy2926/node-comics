import { catalog, sourceRemovalKey } from '../repositories';
import type { Comic, Entry, SourceArtwork, SourceConnection } from '../domain';
import type { IndexedPage, FileIndex } from '../formats/contracts';
import { MAX_ENTRIES } from '../formats/limits';
import { indexFile } from '../formats';
import { openFileSource, closeSourceAccess } from '../sources/runtime';
import { getSourceDriver, listSourceDrivers, requireSourceDriver } from '../sources/registry';
import type {
  RemoteCatalogPage,
  RemoteCatalogRequest,
  RemoteReadingPlan,
} from '../sources/contracts';
import { descriptors } from './import-service';
import { continueEntry } from './library-service';
import { getSourceAccount, listSourceAccounts } from './source-service';
import { restoreSourceResources } from './source-access';
import { sourceCoverOwner } from './cover-access';
import { sourceLock } from './locks';
import { sourceRangeCache } from '../../storage/source-ranges';
import { sourcePageCache } from '../../storage/source-pages';
import { thumbnailCache } from '../../storage/thumbnails';
import { downloadStore } from '../../storage/downloads';
import {
  openContainer,
  retainContainer,
  releaseContainer,
  type ManagedContainer,
} from '../../storage/containers';
import { SourceDatabaseSchemaError } from '../../storage/database';

export type {
  RemoteCatalogPage,
  RemotePublication,
  RemoteReadingPlan,
  SourceConnectionField,
} from '../sources/contracts';
export type { SourceArtwork } from '../domain';
export type RemoteOpenResult =
  | { kind: 'opened'; comicId: string; entryId: string; created: boolean }
  | { kind: 'download-required'; plan: RemoteReadingPlan };
export class RemoteFileDownloadRequiredError extends Error {
  readonly kind = 'download-required';
  constructor(
    readonly plan: RemoteReadingPlan,
    readonly reason: 'not-retained' | 'source-changed',
  ) {
    super(
      reason === 'source-changed'
        ? '源文件内容已变化。请移除此漫画后从远端书库重新打开并保存完整文件。'
        : '此源文件需要先保存完整文件，请在远端书库打开该出版物并确认下载。',
    );
    this.name = 'RemoteFileDownloadRequiredError';
  }
}
export interface RemoteDownloadGuard {
  id: string;
  generation: number;
}
export interface RemoteRegistrationContext {
  connection: SourceConnection;
  plan: RemoteReadingPlan;
  sourceRemovalVersion?: number;
}
const sourceKey = (connectionId: string, publicationId: string) =>
  JSON.stringify([connectionId, publicationId]);
const removalVersion = async (key: string) =>
  Number((await catalog.get('tombstones', sourceRemovalKey(key)))?.deletedAt ?? 0);
const stopped = () => new DOMException('来源连接或阅读请求已变化，请重试。', 'AbortError');
const allowed = (connection: SourceConnection) =>
  !['disconnected', 'revoked'].includes(connection.status);

export const listRemoteProviders = () =>
  listSourceDrivers()
    .filter(
      (provider) =>
        provider.catalog && provider.connection?.connect && provider.isConfigured?.() !== false,
    )
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      fields: provider.connection!.fields ?? [],
    }));

export async function listRemoteLibraries() {
  const { accounts, errors } = await listSourceAccounts(
    listSourceDrivers()
      .filter((provider) => provider.catalog)
      .map((provider) => provider.id),
  );
  return {
    connections: accounts.filter((account) => !!getSourceDriver(account.provider)?.catalog),
    errors,
  };
}

export async function remoteLibraryConfiguration(connectionId: string) {
  const account = await getSourceAccount(connectionId),
    provider = requireSourceDriver(account.provider);
  if (!provider.catalog) throw Error('此来源不支持书库浏览。');
  return provider.connection?.configuration
    ? provider.connection.configuration(account)
    : { name: account.displayName };
}

export async function connectRemoteLibrary(
  providerId: string,
  values: Record<string, string>,
  existingId?: string,
  signal?: AbortSignal,
): Promise<SourceConnection> {
  signal?.throwIfAborted();
  const provider = requireSourceDriver(providerId);
  if (!provider.catalog || !provider.connection?.connect) throw Error('此来源不支持连接远端书库。');
  if(existingId&&await catalog.get('tombstones','connections:'+existingId))throw stopped();
  const previous = existingId ? await catalog.get('connections', existingId) : undefined;
  const account = existingId ? await getSourceAccount(existingId) : undefined;
  if (account && account.provider !== providerId) throw Error('来源账户身份不匹配。');
  const connected = await provider.connection.connect(values, account, signal);
  signal?.throwIfAborted();
  if (
    !connected.id ||
    connected.provider !== providerId ||
    connected.status !== 'connected' ||
    (account && (connected.id !== account.id || connected.accountId !== account.accountId))
  )
    throw Error('来源账户身份不匹配。');
  if (previous) await closeSourceAccess({ connectionId: previous.id });
  const saved = await catalog.mutate(['connections'], async (tx) => {
    signal?.throwIfAborted();
    if(await tx.get('tombstones','connections:'+connected.id))throw stopped();
    const current = await tx.get('connections', connected.id);
    if (
      previous &&
      (current?.generation !== previous.generation || current.provider !== previous.provider)
    )
      throw stopped();
    if (
      current &&
      (current.provider !== connected.provider || current.accountId !== connected.accountId)
    )
      throw Error('来源账户身份不匹配。');
    const now = Date.now(),
      result: SourceConnection = {
        ...connected,
        generation: current ? current.generation + 1 : 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
    await tx.put('connections', result);
    signal?.throwIfAborted();
    return result;
  });
  await restoreSourceResources(saved, [], saved.generation);
  const current=await catalog.get('connections',saved.id);
  if(!current||current.status!=='connected'||current.generation!==saved.generation)throw stopped();
  return current;
}

async function remoteConnection(id: string): Promise<SourceConnection> {
  const connection = await catalog.get('connections', id);
  if (!connection || !allowed(connection)) throw Error('来源连接已断开，请重新连接。');
  if (!getSourceDriver(connection.provider)?.catalog) throw Error('此来源不支持书库浏览。');
  return connection;
}
async function assertConnection(connection: SourceConnection, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const current = await catalog.get('connections', connection.id);
  if (
    !current ||
    !allowed(current) ||
    current.generation !== connection.generation ||
    current.provider !== connection.provider ||
    current.accountId !== connection.accountId
  )
    throw stopped();
}
export async function browseRemoteLibrary(
  connectionId: string,
  options: Omit<RemoteCatalogRequest, 'connection'> = {},
): Promise<RemoteCatalogPage> {
  const connection = await remoteConnection(connectionId),
    result = await requireSourceDriver(connection.provider).catalog!.browse({
      connection,
      ...options,
    });
  await assertConnection(connection, options.signal);
  return result;
}
export async function readRemoteArtwork(
  connectionId: string,
  artwork: SourceArtwork,
  signal?: AbortSignal,
): Promise<Blob> {
  const connection = await remoteConnection(connectionId),
    reader = requireSourceDriver(connection.provider).artwork;
  if (!reader) throw Error('此来源不提供封面读取。');
  const blob = await reader.read(connection, artwork, signal);
  await assertConnection(connection, signal);
  return blob;
}

function validatePlan(plan: RemoteReadingPlan, publicationId: string) {
  if (
    plan.publication.id !== publicationId ||
    !publicationId ||
    !plan.publication.title ||
    !plan.representationId ||
    !['pages', 'range-file', 'download-file'].includes(plan.kind) ||
    (plan.kind === 'pages'
      ? plan.format !== 'image-sequence'
      : !['cbz', 'cbr', 'mobi', 'pdf', 'epub'].includes(plan.format))
  )
    throw Error('来源返回了无效的阅读资源。');
  if (plan.publication.readable === false)
    throw Error(plan.publication.reason ?? '此出版物暂不支持阅读。');
}
export function remoteSourceContext(
  { connection, plan }: RemoteRegistrationContext,
  contentId: string,
  entryId = 'pending:' + contentId,
  signal?: AbortSignal,
) {
  return {
    connection,
    source: {
      connectionId: connection.id,
      providerItemId: plan.publication.id,
      locator: plan.locator,
      generation: 1,
      status: 'active' as const,
    },
    entryId,
    contentId,
    format: plan.format,
    sourceSnapshot: plan.snapshot,
    signal,
  };
}
function validatePages(pages: IndexedPage[]) {
  if (
    !pages.length ||
    pages.length > 1500 ||
    pages.some((page, index) => page.ordinal !== index || !page.name || !page.locator)
  )
    throw Error('来源没有有效的完整页面索引。');
  const ids = descriptors('validation', pages).map((page) => page.pageId);
  if (new Set(ids).size !== ids.length) throw Error('来源页面身份重复。');
}
function sameRepresentation(entry: Entry, plan: RemoteReadingPlan) {
  return (
    entry.format === plan.format &&
    JSON.stringify(entry.sourceSnapshot) === JSON.stringify(plan.snapshot)
  );
}
function validateIndex(index: FileIndex) {
  if(index.kind==='images')return validatePages(index.pages);
  if(!index.chapters.length||index.chapters.length>MAX_ENTRIES||new Set(index.chapters.map(chapter=>chapter.id)).size!==index.chapters.length)
    throw Error('电子书没有有效的完整章节索引。');
}
async function indexRemotePlan(
  context: RemoteRegistrationContext,
  contentId: string,
  entryId: string,
  signal?: AbortSignal,
  containerId?: string,
) {
  const provider = requireSourceDriver(context.connection.provider),
    input = { ...remoteSourceContext(context, contentId, entryId, signal), containerId };
  if (context.plan.kind === 'pages') {
    if (!provider.pages) throw Error('此来源不提供逐页读取。');
    const index = await provider.pages.index(input);
    if (!index.complete || (index.total !== undefined && index.total !== index.pages.length))
      throw Error('来源页数尚未完整确认。');
    validatePages(index.pages);
    return {kind:'images' as const,pages:index.pages};
  }
  const source = await openFileSource(input);
  try {
    const index = await indexFile(context.plan.format, source, signal);
    validateIndex(index);
    return index;
  } finally {
    await source.close();
  }
}
async function publishRemote(
  context: RemoteRegistrationContext,
  index: FileIndex,
  contentId: string,
  containerId?: string,
  guard?: RemoteDownloadGuard,
  signal?: AbortSignal,
) {
  validateIndex(index);
  const pages=index.kind==='images'?index.pages:[],document=index.kind==='epub'?index:undefined;
  return catalog.mutate(
    ['connections', 'comics', 'entries', 'pageDescriptors', 'metadata'],
    async (tx) => {
      signal?.throwIfAborted();
      const { connection, plan } = context,
        current = await tx.get('connections', connection.id);
      if (!current || !allowed(current) || current.generation !== connection.generation)
        throw stopped();
      const intent = guard ? await tx.get('metadata', guard.id) : undefined;
      if (guard) {
        if (
          !intent ||
          intent.generation !== guard.generation ||
          intent.status !== 'running' ||
          intent.connectionGeneration !== connection.generation
        )
          throw stopped();
        if (typeof intent.comicId === 'string') {
          const owner = await tx.get('comics', intent.comicId);
          if (
            !owner ||
            owner.source.generation !== intent.sourceGeneration ||
            owner.source.status !== 'active'
          )
            throw stopped();
        }
      }
      const key = sourceKey(connection.id, plan.publication.id),
        removed = await tx.get('tombstones', sourceRemovalKey(key));
      const expectedRemoval =
        typeof intent?.sourceRemovalVersion === 'number'
          ? intent.sourceRemovalVersion
          : context.sourceRemovalVersion;
      if (expectedRemoval !== undefined && Number(removed?.deletedAt ?? 0) !== expectedRemoval)
        throw stopped();
      const finish = async <T extends { comicId: string; entryId: string; contentId: string }>(
        result: T,
      ) => {
        signal?.throwIfAborted();
        if (intent)
          await tx.put('metadata', {
            ...intent,
            comicId: result.comicId,
            entryId: result.entryId,
            contentId: result.contentId,
            containerId,
            status: 'complete',
            owner: undefined,
            error: undefined,
            updatedAt: Date.now(),
          });
        return result;
      };
      const [existing] = await tx.list('comics', { index: 'sourceKey', range: key, limit: 1 });
      if (existing) {
        if (existing.source.status !== 'active') throw Error('此出版物的访问已撤销，请重新授权。');
        const [entry] = await tx.list('entries', {
          index: 'comicId',
          range: existing.id,
          limit: 1,
        });
        if (!entry) throw Error('漫画目录缺失，请移除后重新打开。');
        if (!sameRepresentation(entry, plan))
          throw new RemoteFileDownloadRequiredError(plan, 'source-changed');
        if (containerId) await tx.put('entries', { ...entry, containerId, updatedAt: Date.now() });
        return finish({
          comicId: existing.id,
          entryId: entry.id,
          created: false,
          contentId: entry.contentId,
          previousContainerId: entry.containerId,
        });
      }
      const now = Date.now(),
        comicId = crypto.randomUUID(),
        entryId = crypto.randomUUID(),
        values = descriptors(contentId, pages);
      const comic: Comic = {
        id: comicId,
        sourceKey: key,
        title: plan.publication.title,
        sourceName: connection.displayName,
        source: {
          connectionId: connection.id,
          providerItemId: plan.publication.id,
          locator: plan.locator,
          generation: 1,
          status: 'active',
        },
        sourceArtwork: plan.publication.artwork,
        startEntryId: entryId,
        cover: values.length?{ entryId, contentId, pageId: values[0].pageId, format: plan.format }:undefined,
        documentCover:document?.cover?{entryId,contentId}:undefined,
        createdAt: now,
        updatedAt: now,
      };
      const entry: Entry = {
        id: entryId,
        comicId,
        title: comic.title,
        order: 0,
        format: plan.format,
        contentId,
        generation: 1,
        indexState: 'ready',
        containerId,
        sourceSnapshot: plan.snapshot,
        document,
        acquisition: { kind: plan.kind, representationId: plan.representationId },
        createdAt: now,
        updatedAt: now,
        pageCount: pages.length,
        knownTotal: pages.length,
        discoveryComplete: true,
        coverPageId: values[0]?.pageId,
      };
      await tx.put('comics', comic);
      await tx.put('entries', entry);
      for (const page of values) await tx.put('pageDescriptors', page);
      return finish({ comicId, entryId, created: true, contentId, previousContainerId: undefined });
    },
  );
}

/** Browsing never creates reading records. Only an explicit open publishes a verified index. */
async function openPublication(
  connectionId: string,
  publicationId: string,
  signal: AbortSignal,
): Promise<RemoteOpenResult> {
  const connection = await remoteConnection(connectionId),
    key = sourceKey(connectionId, publicationId),
    sourceRemovalVersion = await removalVersion(key);
  const [existing] = await catalog.list('comics', { index: 'sourceKey', range: key, limit: 1 });
  if (existing) {
    if (existing.source.status !== 'active') throw Error('此出版物的访问已撤销，请重新授权。');
    const entry = await continueEntry(existing.id);
    await assertConnection(connection, signal);
    if (entry) {
      let needsDownload = entry.acquisition?.kind === 'download-file' && !entry.containerId;
      if (entry.acquisition?.kind === 'download-file' && entry.containerId) {
        try {
          const retained = await openContainer(entry.containerId);
          await retained.close();
        } catch (error) {
          if (error instanceof SourceDatabaseSchemaError) throw error;
          needsDownload = true;
        }
      }
      if (!needsDownload)
        return { kind: 'opened', comicId: existing.id, entryId: entry.id, created: false };
      const plan = await requireSourceDriver(connection.provider).catalog!.resolve(
        connection,
        publicationId,
        { purpose: 'download', signal },
      );
      validatePlan(plan, publicationId);
      await assertConnection(connection, signal);
      if (plan.kind === 'pages') throw Error('来源已不再提供原来的完整文件。');
      if (!sameRepresentation(entry, plan))
        throw new RemoteFileDownloadRequiredError(plan, 'source-changed');
      return { kind: 'download-required', plan };
    }
  }
  const plan = await requireSourceDriver(connection.provider).catalog!.resolve(
    connection,
    publicationId,
    { purpose: 'read', signal },
  );
  validatePlan(plan, publicationId);
  await assertConnection(connection, signal);
  if (plan.kind === 'download-file') return { kind: 'download-required', plan };
  const contentId = crypto.randomUUID(),
    context = { connection, plan, sourceRemovalVersion },
    input = remoteSourceContext(context, contentId, undefined, signal);
  try {
    const index = await indexRemotePlan(context, contentId, input.entryId, signal);
    await assertConnection(connection, signal);
    const result = await sourceLock(() =>
      publishRemote(context, index, contentId, undefined, undefined, signal),
    );
    await sourceRangeCache.adoptOwner(input.entryId, result.entryId, result.contentId);
    return { kind: 'opened', ...result };
  } finally {
    await sourceRangeCache.deleteOwner(input.entryId, true);
  }
}

/** Only an explicit reload refreshes the chosen representation; ordinary reopen stays network-free. */
export async function reloadRemoteEntry(entryId: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const entry = await catalog.get('entries', entryId),
    comic = entry && (await catalog.get('comics', entry.comicId));
  const connection = comic && (await catalog.get('connections', comic.source.connectionId)),
    provider = connection && getSourceDriver(connection.provider);
  if (!provider?.catalog) return false;
  if (!entry || !comic || !connection || !allowed(connection) || comic.source.status !== 'active')
    throw stopped();
  const plan = await provider.catalog.resolve(connection, comic.source.providerItemId, {
    purpose: 'read',
    signal,
  });
  validatePlan(plan, comic.source.providerItemId);
  await assertConnection(connection, signal);
  const same = sameRepresentation(entry, plan),
    containerId = same ? entry.containerId : undefined;
  if (plan.kind === 'download-file' && !containerId)
    throw new RemoteFileDownloadRequiredError(plan, same ? 'not-retained' : 'source-changed');
  const preparedContentId = crypto.randomUUID(),
    owner = 'pending:' + preparedContentId,
    context = { connection, plan };
  try {
    const index = await indexRemotePlan(context, preparedContentId, owner, signal, containerId),
      pages=index.kind==='images'?index.pages:[],document=index.kind==='epub'?index:undefined,
      incoming = descriptors(entry.contentId, pages);
    const result = await sourceLock(() =>
      catalog.mutate(
        ['entries', 'comics', 'connections', 'pageDescriptors', 'materializations', 'positions'],
        async (tx) => {
          signal?.throwIfAborted();
          const current = await tx.get('entries', entry.id),
            book = await tx.get('comics', comic.id),
            access = await tx.get('connections', connection.id);
          if (
            !current ||
            current.contentId !== entry.contentId ||
            current.generation !== entry.generation ||
            !book ||
            book.source.generation !== comic.source.generation ||
            book.source.status !== 'active' ||
            !access ||
            access.generation !== connection.generation ||
            !allowed(access)
          )
            throw stopped();
          const previous = await tx.list('pageDescriptors', {
            index: 'contentOrdinal',
            range: IDBKeyRange.bound([entry.contentId, -Infinity], [entry.contentId, Infinity]),
            limit: 1500,
          });
          // A page feed cannot prove unchanged bytes from stable URLs/counts. Explicit reload starts fresh;
          // only a file representation with the same validated snapshot may retain its reading identity.
          const changed =
            plan.kind === 'pages' ||
            !same ||
            previous.length !== incoming.length ||
            previous.some((page, index) => page.pageId !== incoming[index]?.pageId);
          const contentId = changed ? preparedContentId : entry.contentId,
            values = changed ? descriptors(contentId, pages) : incoming;
          if (changed) {
            for (const page of previous)
              await tx.remove('pageDescriptors', [page.contentId, page.pageId]);
            for (const value of await tx.list('materializations', {
              index: 'contentId',
              range: entry.contentId,
              limit: 5000,
            }))
              await tx.remove('materializations', value.id);
            const position = await tx.get('positions', entry.id);
            if (position)
              await tx.put('positions', {
                ...position,
                contentId,
                pageId: values[0]?.pageId??'',
                documentLocation:undefined,
                relativeOffset: 0,
              });
          }
          for (const page of values) await tx.put('pageDescriptors', page);
          const now = Date.now();
          await tx.put('entries', {
            ...current,
            format: plan.format,
            contentId,
            containerId: changed ? undefined : containerId,
            sourceSnapshot: plan.snapshot,
            document,
            acquisition: { kind: plan.kind, representationId: plan.representationId },
            generation: current.generation + 1,
            indexState: 'ready',
            error: undefined,
            readAt: changed ? undefined : current.readAt,
            pageCount: pages.length,
            knownTotal: pages.length,
            discoveryComplete: true,
            coverPageId: values[0]?.pageId,
            updatedAt: now,
          });
          await tx.put('comics', {
            ...book,
            source: {
              ...book.source,
              locator: plan.locator,
              generation: book.source.generation + 1,
            },
            sourceArtwork: plan.publication.artwork,
            documentCover:document?.cover?{entryId:entry.id,contentId}:undefined,
            ...(book.cover?.entryId === entry.id
              ? {
                  cover: values.length ? {
                    entryId: entry.id,
                    contentId,
                    pageId: values[0].pageId,
                    format: plan.format,
                  } : undefined,
                }
              : {}),
            ...(changed && book.lastEntryId === entry.id
              ? { lastPage: 1, lastPageCount: pages.length }
              : {}),
            updatedAt: now,
          });
          signal?.throwIfAborted();
          return { changed, contentId };
        },
      ),
    );
    await thumbnailCache.deleteOwner(sourceCoverOwner(comic.id));
    if (result.changed) {
      await Promise.all([
        sourcePageCache.deleteOwner(entry.id),
        sourceRangeCache.deleteOwner(entry.id),
        thumbnailCache.deleteOwner(entry.id),
        downloadStore.deleteOwner(entry.id),
      ]);
      if (entry.containerId) await releaseContainer(entry.containerId, entry.contentId);
    }
    await sourceRangeCache.adoptOwner(owner, entry.id, result.contentId);
    return true;
  } finally {
    await sourceRangeCache.deleteOwner(owner, true);
  }
}

const opening = new Map<
  string,
  { controller: AbortController; promise: Promise<RemoteOpenResult>; users: number }
>();
/** Repeated clicks share one preparation; cancelling one view cannot cancel another reader. */
export async function openRemotePublication(
  connectionId: string,
  publicationId: string,
  signal?: AbortSignal,
): Promise<RemoteOpenResult> {
  signal?.throwIfAborted();
  const key = sourceKey(connectionId, publicationId);
  let work = opening.get(key);
  if (!work) {
    const controller = new AbortController();
    work = {
      controller,
      promise: openPublication(connectionId, publicationId, controller.signal),
      users: 0,
    };
    opening.set(key, work);
  }
  const current = work;
  current.users++;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason ?? stopped());
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([current.promise, cancelled]);
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!--current.users) {
      current.controller.abort();
      if (opening.get(key) === current) opening.delete(key);
    }
  }
}

/** Shelf entries use the same availability/confirmation decision as their remote catalog. */
export async function openRegisteredRemoteComic(
  comicId: string,
  signal?: AbortSignal,
): Promise<RemoteOpenResult | undefined> {
  signal?.throwIfAborted();
  const comic = await catalog.get('comics', comicId);
  if (!comic) throw Error('漫画已移除。');
  const connection = await catalog.get('connections', comic.source.connectionId);
  if (!connection) throw Error('漫画来源已移除。');
  if (!getSourceDriver(connection.provider)?.catalog) return;
  return openRemotePublication(connection.id, comic.source.providerItemId, signal);
}

/** Opening the body is reserved for the confirmed download executor. */
export async function resolveRemoteDownload(
  connectionId: string,
  publicationId: string,
  signal?: AbortSignal,
) {
  const connection = await remoteConnection(connectionId),
    provider = requireSourceDriver(connection.provider);
  const sourceRemovalVersion = await removalVersion(sourceKey(connectionId, publicationId));
  const plan = await provider.catalog!.resolve(connection, publicationId, {
    purpose: 'download',
    signal,
  });
  validatePlan(plan, publicationId);
  if (plan.kind === 'pages' || !provider.files?.download)
    throw Error('此出版物不提供完整文件下载。');
  await assertConnection(connection, signal);
  const transfer = await provider.files.download(
    remoteSourceContext({ connection, plan }, 'download', undefined, signal),
  );
  try {
    await assertConnection(connection, signal);
  } catch (error) {
    await transfer.stream.cancel().catch(() => {});
    throw error;
  }
  return { connection, plan, transfer, sourceRemovalVersion };
}
export async function registerRemoteContainer(
  context: RemoteRegistrationContext,
  container: ManagedContainer,
  contentId: string,
  signal?: AbortSignal,
  guard?: RemoteDownloadGuard,
) {
  validatePlan(context.plan, context.plan.publication.id);
  if (context.plan.kind === 'pages' || context.plan.format !== container.format)
    throw Error('下载文件格式与来源声明不一致。');
  const key = sourceKey(context.connection.id, context.plan.publication.id);
  const sourceRemovalVersion = context.sourceRemovalVersion ?? (await removalVersion(key));
  const source = await openContainer(container.id);
  let index: FileIndex;
  try {
    index = await indexFile(container.format, source, signal);
  } finally {
    await source.close();
  }
  // Indexing and network work stay outside this lock. Selecting and retaining the final
  // owner must serialize with another tab publishing the same remote publication.
  return sourceLock(async () => {
    await assertConnection(context.connection, signal);
    const [existing] = await catalog.list('comics', { index: 'sourceKey', range: key, limit: 1 });
    const entry = existing ? (await catalog.listEntries(existing.id, { limit: 1 }))[0] : undefined;
    const owner = entry?.contentId ?? contentId;
    if (guard && owner !== contentId) {
      await catalog.mutate(['metadata'], async (tx) => {
        const intent = await tx.get('metadata', guard.id);
        if (!intent || intent.status !== 'running' || intent.generation !== guard.generation)
          throw stopped();
        await tx.put('metadata', {
          ...intent,
          importTargetReferenceId: owner,
          updatedAt: Date.now(),
        });
      });
    }
    await retainContainer(container.id, owner);
    let published = false;
    try {
      signal?.throwIfAborted();
      const result = await publishRemote(
        { ...context, sourceRemovalVersion },
        index,
        contentId,
        container.id,
        guard,
        signal,
      );
      published = true;
      if (contentId !== result.contentId) await releaseContainer(container.id, contentId);
      if (result.previousContainerId && result.previousContainerId !== container.id) {
        await releaseContainer(result.previousContainerId, result.contentId);
      }
      return result;
    } catch (error) {
      // A committed entry already owns this reference. Later cleanup failures are recoverable
      // through the download intent and must not roll back the published file.
      if (!published && owner !== contentId) await releaseContainer(container.id, owner);
      throw error;
    }
  });
}
