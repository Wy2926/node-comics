import type { SourceConnection } from '../../domain';
import { msg } from '../../../i18n/runtime';
import type {
  OpenFileSourceContext,
  RemoteCatalogPage,
  RemotePublication,
  RemoteReadingPlan,
  SourceAccount,
  SourceAccessChange,
  SourceProvider,
  SourceReadingProgress,
} from '../contracts';
import { OpdsError } from './errors';
import {
  expandSearch,
  hasRel,
  isAcquisition,
  isBitmap,
  isManifest,
  isPublicationDetail,
  mediaType,
  parseCatalog,
  parsePublication,
  parseSearchDescription,
  PSE_REL,
  type OpdsCatalog,
  type OpdsLink,
  type OpdsPublication,
} from './protocol';
import { publicationAccess } from './publication-access';
import {
  discoverProgressBinding,
  originalPageUrl,
  pseProgress,
  readOpdsProgress,
  unavailableProgressEndpoint,
  writeOpdsProgress,
  type OpdsProgressBinding,
} from './progress';
import {
  editableUrl,
  identityUrl,
  opaqueId,
  PrivateOpdsStore,
  type OpdsStore,
  type PrivateConnection,
  type PrivateResource,
  type OpdsAuth,
} from './private-store';
import { OpdsRangeSource, probeRange, rangeVersion } from './range-source';
import { allowedUrl, IMAGE_LIMIT, OpdsTransport, validateRoot } from './transport';

const PROVIDER = 'opds';
type Opening = {
  publicationId: string;
  kind: RemoteReadingPlan['kind'];
  format: RemoteReadingPlan['format'];
  version: string;
  pages?: OpdsLink[];
  template?: OpdsLink;
  url?: string;
  etag?: string;
  lastModified?: string;
  size?: number;
  title: string;
  progress?: OpdsProgressBinding | null;
};
const cleanText = (v: string, max = 4000) => v.replace(/<[^>]*>/g, '').slice(0, max);
function account(connection: PrivateConnection): SourceAccount {
  return {
    id: connection.id,
    provider: PROVIDER,
    accountId: connection.id,
    displayName: connection.name,
    status: connection.disconnected ? 'disconnected' : 'connected',
    accountMetadata: {
      origin: connection.origin ?? new URL(connection.root).origin,
      protocol: connection.namespace.split(':')[0],
      authentication: connection.auth.kind,
    },
  };
}

export function createOpdsProvider(
  options: { store?: OpdsStore; fetch?: typeof fetch } = {},
): SourceProvider {
  const store = options.store ?? new PrivateOpdsStore(),
    listeners = new Set<() => void>(),
    accessListeners = new Set<(change: SourceAccessChange) => Promise<void>>();
  // One-use connect result, not a general catalog cache. Never retain complete histories.
  const connectedCatalogs = new Map<string, { revision: number; page: RemoteCatalogPage }>();
  const transport = new OpdsTransport(options.fetch, async (connection) => {
    const current = await store.connection(connection.id);
    if (!current || current.disconnected || current.revision !== connection.revision)
      throw new OpdsError('disconnected', 'OPDS 连接授权已变更，请重新打开。');
  });
  let broadcast: BroadcastChannel | undefined;
  function listen() {
    if (!broadcast && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
      broadcast = new BroadcastChannel('node-comics-opds-connections');
      broadcast.onmessage = (event) => {
        if (
          ['disconnected', 'credentials'].includes(event.data?.type) &&
          typeof event.data.id === 'string'
        )
          void changed(event.data.id, false, event.data.type === 'disconnected');
      };
    }
  }
  async function changed(id: string, notify = true, accessLost = true) {
    connectedCatalogs.delete(id);
    transport.abortConnection(id);
    if (!notify || accessLost) store.clearTransient?.(id);
    for (const listener of listeners) listener();
    if (accessLost)
      await Promise.allSettled(
        [...accessListeners].map((listener) => listener({ connectionId: id })),
      );
    if (notify)
      broadcast?.postMessage({
        type: accessLost ? 'disconnected' : 'credentials',
        id,
      });
  }
  async function connectionFor(
    value: Pick<SourceConnection, 'id' | 'provider'>,
    allowDisconnected = false,
  ) {
    listen();
    const connection = value.provider === PROVIDER ? await store.connection(value.id) : undefined;
    if (!connection || (connection.disconnected && !allowDisconnected))
      throw new OpdsError('disconnected', 'OPDS 连接已断开，请重新添加。');
    return connection;
  }
  async function resourceFor(
    connection: PrivateConnection,
    id: string,
    kind: PrivateResource['kind'],
  ) {
    const resource = await store.resource(id);
    if (
      !resource ||
      resource.connectionId !== connection.id ||
      resource.kind !== kind ||
      resource.revision !== connection.revision
    )
      throw new OpdsError('source-changed', 'OPDS 目录引用已过期，请返回目录重新打开。');
    return resource;
  }
  const record = (
    connection: PrivateConnection,
    id: string,
    kind: PrivateResource['kind'],
    value: Record<string, unknown>,
    pinned = false,
  ): PrivateResource => ({
    id,
    kind,
    value,
    connectionId: connection.id,
    revision: connection.revision,
    pinned,
    updatedAt: Date.now(),
  });
  async function catalogReference(
    connection: PrivateConnection,
    url: string,
    records: PrivateResource[],
  ) {
    const id = await opaqueId(
      connection.id,
      'catalog',
      `${connection.namespace}:${identityUrl(url, connection)}`,
    );
    records.push(record(connection, id, 'catalog', { url }));
    return id;
  }
  async function publicationReference(
    connection: PrivateConnection,
    pub: OpdsPublication,
    protocol: string,
    records: PrivateResource[],
    catalogUrl?: string,
  ): Promise<RemotePublication> {
    const fallback = pub.links.find(
      (l) => isAcquisition(l) || hasRel(l, PSE_REL) || isManifest(l) || isPublicationDetail(l),
    );
    if (!pub.identity && !fallback)
      throw new OpdsError('unsupported', '出版物缺少可识别的目录记录或读取地址。');
    const identity = identityUrl(pub.identity ?? fallback!.href, connection),
      id = await opaqueId(
        connection.id,
        'publication',
        `${connection.namespace}:${protocol}:${identity}`,
      );
    records.push(
      record(connection, id, 'publication', {
        publication: pub,
        protocol,
        ...(catalogUrl ? { catalogUrl } : {}),
      }),
    );
    const art =
      pub.images.find((l) => hasRel(l, 'http://opds-spec.org/image/thumbnail')) ?? pub.images[0];
    let artwork: RemotePublication['artwork'];
    if (art) {
      const imageId = await opaqueId(
        connection.id,
        'artwork',
        `${id}:${identityUrl(art.href, connection)}`,
      );
      records.push(record(connection, imageId, 'artwork', { link: art }));
      artwork = { id: imageId, locator: { resourceId: imageId } };
    }
    const access = publicationAccess(pub);
    return {
      id,
      title: cleanText(pub.title, 300),
      authors: pub.authors.map((v) => cleanText(v, 300)),
      summary: pub.summary ? cleanText(pub.summary) : undefined,
      artwork,
      formats: [...new Set(access.files.map((file) => file.format))],
      size: access.files[0]?.link.size,
      readable: access.readable,
      reason: access.readable === false ? access.unavailableReason : undefined,
    };
  }
  async function prepareCatalog(
    connection: PrivateConnection,
    catalog: OpdsCatalog,
    url: string,
  ): Promise<{ page: RemoteCatalogPage; records: PrivateResource[] }> {
    const records: PrivateResource[] = [],
      location = await catalogReference(connection, url, records);
    const navigation = async (links: OpdsLink[]) =>
      Promise.all(
        links.map(async (link) => {
          const location = await catalogReference(connection, link.href, records);
          return {
            id: location,
            location,
            title: cleanText(link.title ?? msg('书库目录'), 300),
          };
        }),
      );
    const pubs = (values: OpdsPublication[]) =>
      Promise.all(
        values.map((pub) => publicationReference(connection, pub, catalog.protocol, records, url)),
      );
    const result: RemoteCatalogPage = {
      title: cleanText(catalog.title, 300),
      location,
      navigation: await navigation(catalog.navigation),
      publications: await pubs(catalog.publications),
      groups: [],
      facets: [],
      searchable: catalog.links.some((l) => hasRel(l, 'search')),
    };
    for (const group of catalog.groups) {
      const self = group.links.find((l) => hasRel(l, 'self'));
      result.groups!.push({
        title: cleanText(group.title, 300),
        navigation: await navigation([
          ...group.navigation,
          ...(self ? [{ ...self, title: msg('查看全部') }] : []),
        ]),
        publications: await pubs(group.publications),
      });
    }
    for (const facet of catalog.facets) {
      const links = await navigation(facet.links);
      result.facets!.push({
        title: cleanText(facet.title, 300),
        links: links.map((link, i) => ({
          ...link,
          active: facet.links[i].active || hasRel(facet.links[i], 'self'),
        })),
      });
    }
    for (const [field, rels] of [
      ['next', ['next']],
      ['previous', ['previous', 'prev']],
    ] as const) {
      const link = catalog.links.find((l) => rels.some((r) => hasRel(l, r)));
      if (link) result[field] = await catalogReference(connection, link.href, records);
    }
    const search = catalog.links.find((l) => hasRel(l, 'search'));
    if (search) records.find((r) => r.id === location)!.value.search = search;
    const rootLocation = await catalogReference(connection, connection.root, records);
    result.breadcrumbs = [{ title: connection.name, location: rootLocation }];
    // Duplicate self/root records must not overwrite the search discovery above.
    const unique = new Map<string, PrivateResource>();
    for (const item of records) if (!unique.has(item.id)) unique.set(item.id, item);
    if (rootLocation !== location) {
      const root = await store.resource(rootLocation),
        reference = unique.get(rootLocation)!;
      if (
        root?.kind === 'catalog' &&
        root.connectionId === connection.id &&
        root.revision === connection.revision
      )
        reference.value = { ...root.value, ...reference.value };
    }
    if (unique.size > 2000)
      throw new OpdsError('too-large', 'OPDS 单页目录过大，请在服务端缩小目录分页。');
    return { page: result, records: [...unique.values()] };
  }
  async function normalized(connection: PrivateConnection, catalog: OpdsCatalog, url: string) {
    const prepared = await prepareCatalog(connection, catalog, url);
    await store.saveResources(prepared.records);
    return prepared.page;
  }
  async function openingFor(context: OpenFileSourceContext) {
    const connection = await connectionFor(context.connection),
      id = context.source.locator.representationId;
    if (
      typeof id !== 'string' ||
      context.source.locator.publicationId !== context.source.providerItemId
    )
      throw new OpdsError('source-changed', 'OPDS 读取绑定无效，请重新打开。');
    const resource = await resourceFor(connection, id, 'opening'),
      opening = resource.value as unknown as Opening;
    if (
      opening.publicationId !== context.source.providerItemId ||
      context.sourceSnapshot?.version !== opening.version
    )
      throw new OpdsError('source-changed', 'OPDS 读取版本已变更，请重新打开。');
    if (opening.progress === undefined) {
      const publication = await resourceFor(connection, opening.publicationId, 'publication');
      opening.progress = discoverProgressBinding(
        connection,
        publication.value.publication as unknown as OpdsPublication,
        opening,
      );
      await store.saveResources([
        { ...resource, value: opening as unknown as Record<string, unknown> },
      ]);
    }
    return { connection, opening, id };
  }
  async function markProgressVerification(
    connection: PrivateConnection,
    opening: Opening,
    id: string,
    verified: boolean,
  ) {
    if (opening.progress?.kind !== 'kavita' || opening.progress.verified === verified) return;
    opening.progress.verified = verified;
    await store.saveResources([
      record(connection, id, 'opening', opening as unknown as Record<string, unknown>, true),
    ]);
  }
  async function readOpeningProgress(
    connection: PrivateConnection,
    opening: Opening,
    id: string,
    signal?: AbortSignal,
  ): Promise<SourceReadingProgress | undefined | null> {
    signal?.throwIfAborted();
    if (!opening.progress) return pseProgress(opening, opening.progress) ?? null;
    try {
      const progress = await readOpdsProgress(
        transport,
        connection,
        opening.progress,
        opening,
        signal,
      );
      signal?.throwIfAborted();
      await markProgressVerification(connection, opening, id, true);
      return progress;
    } catch (error) {
      signal?.throwIfAborted();
      if (opening.progress.kind === 'readium' && error instanceof OpdsError &&
        [404, 405, 501].includes(Number(error.details?.status))) return null;
      if (opening.progress.kind !== 'kavita' || !unavailableProgressEndpoint(error)) throw error;
      // Optional Reader API failure must not block the advertised PSE route. Keep the
      // profile identity and zero-based lastRead, but never use its unverified endpoints.
      await markProgressVerification(connection, opening, id, false);
      return pseProgress(opening, opening.progress) ?? null;
    }
  }
  return {
    id: PROVIDER,
    label: 'OPDS',
    cachePages: true,
    cacheRanges: true,
    connection: {
      get fields() {
        return [
          {
            id: 'name',
            label: msg('名称'),
            type: 'text' as const,
            required: true,
          },
          {
            id: 'url',
            label: msg('OPDS 目录地址'),
            type: 'url' as const,
            required: true,
            placeholder: 'https://server.example/opds',
            showWhen: { field: 'auth', values: ['anonymous', 'basic'] },
          },
          {
            id: 'auth',
            label: msg('授权方式'),
            type: 'select' as const,
            options: [
              { value: 'anonymous', label: msg('无需授权') },
              { value: 'basic', label: msg('Basic 用户名和密码') },
              { value: 'url-token', label: msg('地址已包含访问令牌') },
            ],
          },
          {
            id: 'tokenUrl',
            label: msg('含访问令牌的 OPDS 地址'),
            type: 'password' as const,
            required: true,
            sensitive: true,
            showWhen: { field: 'auth', values: ['url-token'] },
          },
          {
            id: 'username',
            label: msg('用户名'),
            type: 'text' as const,
            required: true,
            sensitive: true,
            showWhen: { field: 'auth', values: ['basic'] },
          },
          {
            id: 'password',
            label: msg('密码'),
            type: 'password' as const,
            required: true,
            sensitive: true,
            showWhen: { field: 'auth', values: ['basic'] },
          },
        ];
      },
      async configuration(value) {
        const connection = await connectionFor(value, true);
        const url = editableUrl(connection);
        return {
          name: connection.name,
          auth: connection.auth.kind,
          _revision: String(connection.revision),
          ...(url ? { url } : {}),
        };
      },
      async connect(values, existing, signal) {
        const previous = existing ? await connectionFor(existing, true) : undefined;
        if (previous && values._revision !== undefined && values._revision !== String(previous.revision))
          throw new OpdsError('disconnected', 'OPDS 授权已在其他页面变更，请重新连接。');
        const kind = values.auth ?? previous?.auth.kind ?? 'anonymous';
        if (!['anonymous', 'basic', 'url-token'].includes(kind))
          throw new OpdsError('unsupported-auth', 'OPDS 授权方式不受支持。');
        const previousBasic = previous?.auth.kind === 'basic' && !previous.disconnected
          ? previous.auth : undefined;
        const auth: OpdsAuth =
          kind === 'basic'
            ? {
                kind: 'basic',
                username: values.username || previousBasic?.username || '',
                password: values.password || previousBasic?.password || '',
              }
            : kind === 'url-token'
              ? { kind: 'url-token' }
              : { kind: 'anonymous' };
        if (
          auth.kind === 'basic' &&
          (!auth.username || !auth.password || auth.username.includes(':'))
        )
          throw new OpdsError('authentication-required', '请填写有效的 Basic 用户名和密码。');
        const inputUrl = auth.kind === 'url-token'
          ? (values.tokenUrl !== undefined ? values.tokenUrl : values.url)?.trim()
          : values.url?.trim();
        const retainedUrl = previous?.auth.kind === auth.kind && !previous.disconnected
          ? previous.root : previous?.configurationUrl;
        if (auth.kind === 'url-token' && !inputUrl && !retainedUrl)
          throw new OpdsError('authentication-required', '请填写含访问令牌的 OPDS 地址。');
        const root = validateRoot(inputUrl || retainedUrl || '', auth.kind !== 'anonymous');
        const connection: PrivateConnection = {
          id: previous?.id ?? `opds:${crypto.randomUUID()}`,
          name: cleanText(values.name?.trim() || new URL(root).hostname, 100),
          root,
          auth,
          revision: (previous?.revision ?? 0) + 1,
          namespace: '',
          createdAt: previous?.createdAt ?? Date.now(),
        };
        connection.origin = new URL(root).origin;
        connection.configurationUrl = editableUrl(connection);
        connection.endpointKey = await opaqueId(
          connection.id,
          'endpoint',
          identityUrl(root, connection),
        );
        connection.accountKey = await opaqueId(
          connection.id,
          'account',
          auth.kind === 'basic' ? auth.username : auth.kind,
        );
        if (
          previous &&
          (connection.endpointKey !== previous.endpointKey ||
            connection.accountKey !== previous.accountKey ||
            auth.kind !== previous.auth.kind)
        )
          throw new OpdsError('scope-blocked', '不能将已有连接改为另一目录或账户，请添加新连接。');
        const document = await new OpdsTransport(options.fetch).document(connection, root, signal),
          catalog = parseCatalog(document.text, root, document.contentType);
        connection.namespace = `${catalog.protocol}:${connection.endpointKey}`;
        if (previous && connection.namespace !== previous.namespace)
          throw new OpdsError('scope-blocked', '不同 OPDS 版本或目录需要单独连接。');
        const prepared = await prepareCatalog(connection, catalog, root);
        signal?.throwIfAborted();
        await store.saveConnection(connection, previous, signal);
        await store.saveResources(prepared.records);
        listen();
        await changed(connection.id, true, false);
        connectedCatalogs.set(connection.id, {
          revision: connection.revision,
          page: prepared.page,
        });
        if (connectedCatalogs.size > 16)
          connectedCatalogs.delete(connectedCatalogs.keys().next().value!);
        return account(connection);
      },
      list: async () => {
        listen();
        return (await store.connections()).map(account);
      },
      subscribe(listener) {
        listen();
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      describe(value) {
        return [
          {
            id: 'origin',
            label: msg('服务地址'),
            value: value.accountMetadata?.origin ?? '',
          },
          {
            id: 'protocol',
            label: msg('协议'),
            value: value.accountMetadata?.protocol ?? '',
          },
        ];
      },
      async disconnect(value) {
        const connection = await connectionFor(value, true);
        await store.disconnect(connection.id);
        await changed(connection.id);
      },
      async remove(value) {
        if (value.provider !== PROVIDER)
          throw new OpdsError('disconnected', 'OPDS 连接已断开，请重新添加。');
        transport.abortConnection(value.id);
        await store.remove(value.id);
        await changed(value.id);
      },
    },
    catalog: {
      async browse(request) {
        const connection = await connectionFor(request.connection),
          ref = request.cursor ?? request.location;
        const initial = connectedCatalogs.get(connection.id);
        connectedCatalogs.delete(connection.id);
        if (!ref && !request.search?.trim() && initial?.revision === connection.revision) {
          request.signal?.throwIfAborted();
          return initial.page;
        }
        let url = connection.root;
        let reference = ref ? await resourceFor(connection, ref, 'catalog') : undefined;
        if (reference) url = String(reference.value.url);
        if (!request.cursor && request.search?.trim()) {
          if (!reference) {
            const id = await opaqueId(
              connection.id,
              'catalog',
              `${connection.namespace}:${identityUrl(url, connection)}`,
            );
            reference = await resourceFor(connection, id, 'catalog');
          }
          let search = reference.value.search as OpdsLink | undefined;
          if (!search) {
            const document = await transport.document(connection, url, request.signal);
            search = parseCatalog(document.text, url, document.contentType).links.find((link) =>
              hasRel(link, 'search'),
            );
          }
          if (!search) throw new OpdsError('unsupported', '此目录没有提供搜索。');
          let template =
            typeof reference.value.searchTemplate === 'string'
              ? reference.value.searchTemplate
              : search.href;
          if (
            !reference.value.searchTemplate &&
            mediaType(search.type) === 'application/opensearchdescription+xml'
          ) {
            const description = await transport.document(connection, search.href, request.signal);
            template = parseSearchDescription(description.text, search.href);
          }
          if (!reference.value.searchTemplate)
            await store.saveResources([
              { ...reference, value: { ...reference.value, search, searchTemplate: template } },
            ]);
          url = expandSearch(template, request.search.trim());
        }
        const document = await transport.document(connection, url, request.signal),
          catalog = parseCatalog(document.text, url, document.contentType);
        return normalized(connection, catalog, url);
      },
      async resolve(publicConnection, publicationId, options = {}) {
        const connection = await connectionFor(publicConnection),
          resource = await resourceFor(connection, publicationId, 'publication');
        let publication = resource.value.publication as unknown as OpdsPublication;
        const initialAccess = publicationAccess(publication),
          detail = initialAccess.detail;
        if (detail) {
          const doc = await transport.document(connection, detail.href, options.signal);
          publication = parsePublication(doc.text, detail.href);
        } else if (
          (resource.value.protocol === 'opds1' ||
            (publication.readingOrder && !initialAccess.manifest)) &&
          typeof resource.value.catalogUrl === 'string'
        ) {
          const catalogUrl = resource.value.catalogUrl,
            doc = await transport.document(connection, catalogUrl, options.signal),
            current = parseCatalog(doc.text, catalogUrl, doc.contentType);
          const fresh = [
            ...current.publications,
            ...current.groups.flatMap((group) => group.publications),
          ].find((pub) => pub.identity === publication.identity);
          if (!fresh)
            throw new OpdsError('source-changed', '出版物已不在原目录页，请重新浏览目录定位。');
          publication = fresh;
        }
        let progressPublication = publication;
        let opening: Opening | undefined,
          access = publicationAccess(publication);
        if (options.purpose !== 'download') {
          let imagePublication = publication,
            imageAccess = access;
          if (access.manifest) {
            const doc = await transport.document(connection, access.manifest.href, options.signal);
            imagePublication = parsePublication(doc.text, access.manifest.href);
            progressPublication = {
              ...imagePublication,
              links: [...imagePublication.links, ...publication.links],
            };
            imageAccess = publicationAccess(progressPublication);
          }
          if (imageAccess.pages)
            opening = {
              publicationId,
              kind: 'pages',
              format: 'image-sequence',
              version: await opaqueId(
                connection.id,
                'version',
                JSON.stringify([
                  imagePublication.modified,
                  imageAccess.pages.map((l) => identityUrl(l.href, connection)),
                ]),
              ),
              pages: imageAccess.pages,
              title: publication.title,
            };
          if (!opening && access.template) {
            const template = access.template;
            opening = {
              publicationId,
              kind: 'pages',
              format: 'image-sequence',
              version: await opaqueId(
                connection.id,
                'version',
                JSON.stringify([
                  publication.modified,
                  identityUrl(template.href, connection),
                  template.count,
                ]),
              ),
              template,
              title: publication.title,
            };
          }
          // The fetched manifest may expose file fallbacks or explain why its body is not an image sequence.
          if (!opening && access.manifest && imagePublication.readingOrder)
            access = {
              ...access,
              files: access.files.length ? access.files : imageAccess.files,
              unavailableReason: imageAccess.unavailableReason,
            };
        }
        if (!opening) {
          const candidate = access.files[0];
          if (!candidate) throw new OpdsError('unsupported', access.unavailableReason);
          const { link: file, format } = candidate,
            range = !['cbz', 'mobi', 'epub'].includes(format)
              ? undefined
              : await probeRange(transport, connection, file.href, options.signal);
          opening = {
            publicationId,
            kind: range ? 'range-file' : 'download-file',
            format,
            version:
              range ? rangeVersion(range) :
              (await opaqueId(
                connection.id,
                'version',
                `${publication.modified ?? ''}:${identityUrl(file.href, connection)}`,
              )),
            url: file.href,
            etag: range?.etag,
            lastModified: range?.lastModified,
            size: range?.size,
            title: publication.title,
          };
        }
        opening.progress = discoverProgressBinding(connection, progressPublication, opening);
        const representationId = await opaqueId(
            connection.id,
            'opening',
            `${publicationId}:${opening.format}:${opening.url ? identityUrl(opening.url, connection) : 'pages'}:${opening.version}`,
          ),
          records: PrivateResource[] = [],
          visible = await publicationReference(
            connection,
            publication,
            String(resource.value.protocol),
            records,
          );
        // Partial-entry details can have a different self link; retain the selected catalog identity.
        visible.id = publicationId;
        visible.readable = true;
        visible.reason = undefined;
        records.push(
          {
            ...resource,
            value: { ...resource.value, publication },
            pinned: true,
            updatedAt: Date.now(),
          },
          record(
            connection,
            representationId,
            'opening',
            opening as unknown as Record<string, unknown>,
            true,
          ),
        );
        if (visible.artwork) {
          const art = records.find((r) => r.id === visible.artwork!.id);
          if (art) art.pinned = true;
        }
        await store.saveResources(records);
        return {
          publication: visible,
          kind:
            options.purpose === 'download' && opening.kind === 'range-file'
              ? 'download-file'
              : opening.kind,
          format: opening.format,
          representationId,
          locator: { publicationId, representationId },
          snapshot: {
            version: opening.version,
            representationId,
            ...(opening.size ? { size: opening.size } : {}),
          },
          size: opening.size,
        };
      },
    },
    pages: {
      async index(context) {
        const { opening, id } = await openingFor(context);
        if (opening.kind !== 'pages') throw new OpdsError('unsupported', '此出版物不是图片序列。');
        const total = opening.pages?.length ?? opening.template?.count ?? 0;
        return {
          complete: true,
          total,
          pages: Array.from({ length: total }, (_, ordinal) => ({
            ordinal,
            name: `${ordinal + 1}`,
            locator: {
              sourceId: `${opening.publicationId}:${ordinal}`,
              contentKey: `${opening.version}:${ordinal}`,
              representationId: id,
              ordinal,
            },
            width: opening.pages?.[ordinal].width,
            height: opening.pages?.[ordinal].height,
          })),
        };
      },
      async read(context, page) {
        const { connection, opening, id } = await openingFor(context),
          ordinal = page.ordinal;
        if (
          page.locator.representationId !== id ||
          page.locator.ordinal !== ordinal ||
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0
        )
          throw new OpdsError('source-changed', 'OPDS 页定位无效。');
        const link =
          opening.pages?.[ordinal] ??
          (opening.template && ordinal < (opening.template.count ?? 0)
            ? {
                ...opening.template,
                href: opening.template.href
                  .replaceAll('{pageNumber}', String(ordinal))
                  .replaceAll('{maxWidth}', '')
                  .replaceAll('{maxHeight}', ''),
              }
            : undefined);
        if (!link) throw new OpdsError('source-changed', 'OPDS 页已不存在。');
        if (opening.progress?.kind === 'kavita' && opening.progress.verified === undefined) {
          await readOpeningProgress(connection, opening, id, context.signal);
        }
        const href =
          opening.progress?.kind === 'kavita' && opening.progress.verified
            ? originalPageUrl(connection, opening.progress, ordinal)!
            : link.href;
        const result = await transport.bytes(connection, href, {
          signal: context.signal,
          maxBytes: IMAGE_LIMIT,
        });
        const type = mediaType(result.headers.get('Content-Type') ?? link.type);
        if (!isBitmap({ ...link, type }))
          throw new OpdsError('unsupported', '源站没有返回支持的原图。');
        return new Blob([result.bytes], { type });
      },
    },
    progress: {
      async read(context) {
        const { connection, opening, id } = await openingFor(context);
        return readOpeningProgress(connection, opening, id, context.signal);
      },
      async write(context, progress) {
        const { connection, opening, id } = await openingFor(context);
        if (!opening.progress) return;
        if (opening.progress.kind === 'kavita') {
          if (opening.progress.verified === undefined)
            await readOpeningProgress(connection, opening, id, context.signal);
          if (!opening.progress.verified) return;
        }
        await writeOpdsProgress(
          transport,
          connection,
          opening.progress,
          opening,
          progress,
          context.signal,
        );
      },
    },
    artwork: {
      async read(publicConnection, artwork, signal) {
        const connection = await connectionFor(publicConnection),
          resource = await resourceFor(connection, artwork.id, 'artwork'),
          link = resource.value.link as unknown as OpdsLink;
        const result = await transport.bytes(connection, link.href, {
          signal,
          maxBytes: IMAGE_LIMIT,
        });
        const type = mediaType(result.headers.get('Content-Type') ?? link.type);
        if (!isBitmap({ ...link, type }))
          throw new OpdsError('unsupported', '封面不是支持的图片。');
        return new Blob([result.bytes], { type });
      },
    },
    files: {
      async open(context) {
        const { connection, opening } = await openingFor(context);
        if (opening.kind !== 'range-file' || !opening.url || (!opening.etag && !opening.lastModified) || !opening.size)
          throw new OpdsError('range-unsupported', '此文件需要先下载再阅读。');
        return new OpdsRangeSource(
          transport,
          connection,
          {
            url: opening.url,
            etag: opening.etag,
            lastModified: opening.lastModified,
            size: opening.size,
            identity: `${connection.id}:${opening.publicationId}`,
          },
          async () => {
            const current = await store.connection(connection.id);
            return current?.revision === connection.revision;
          },
        );
      },
      async download(context) {
        const { connection, opening } = await openingFor(context);
        if (!opening.url || opening.format === 'image-sequence')
          throw new OpdsError('unsupported', '此出版物未提供可下载文件。');
        allowedUrl(connection, opening.url);
        const result = await transport.download(connection, opening.url, context.signal, {
          etag: opening.etag,
          lastModified: opening.lastModified,
          size: opening.size,
        });
        return {
          ...result,
          name: `${cleanText(opening.title, 180).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.${opening.format}`,
        };
      },
    },
    subscribe(listener) {
      accessListeners.add(listener);
      return () => {
        accessListeners.delete(listener);
      };
    },
  };
}
export const opdsProvider = createOpdsProvider();
