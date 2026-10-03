import type { SourceReadingProgress } from '../contracts';
import type { ComicFormat } from '../../formats/contracts';
import { OpdsError } from './errors';
import type { PrivateConnection } from './private-store';
import { hasRel, mediaType, type OpdsLink, type OpdsPublication } from './protocol';
import { allowedUrl, type OpdsTransport } from './transport';

const progressTarget = Symbol('validated-opds-progress-target');
/** Only this module turns a verified profile or advertised progression link into a write target. */
export interface OpdsProgressTarget {
  readonly url: string;
  readonly method: 'POST' | 'PUT' | 'PATCH';
  readonly [progressTarget]: true;
}

interface KavitaProgressBinding {
  kind: 'kavita';
  prefix: string;
  chapterId: number;
  volumeId: number;
  seriesId: number;
  libraryId: number;
  /** Undefined until checked; false suppresses page-driven retries until an explicit progress read. */
  verified?: boolean;
}
export type OpdsProgressBinding = KavitaProgressBinding | { kind: 'readium'; url: string };
export interface ProgressOpening {
  format: ComicFormat | 'image-sequence';
  pages?: OpdsLink[];
  template?: OpdsLink;
}

const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const fraction = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const invalidProgress = () => new OpdsError('invalid-catalog', '源站返回的阅读进度无效。');
const modifiedAt = (value: unknown) => {
  const result = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
};

export function pseProgress(
  opening: ProgressOpening,
  binding?: OpdsProgressBinding | null,
): SourceReadingProgress | undefined {
  const { lastRead, lastReadDate, count } = opening.template ?? {};
  const zeroBased = binding?.kind === 'kavita';
  if (
    typeof lastRead !== 'number' ||
    !Number.isSafeInteger(lastRead) ||
    lastRead < (zeroBased ? 0 : 1) ||
    lastRead > (count ?? 0) ||
    !count
  )
    return;
  const updatedAt = modifiedAt(lastReadDate);
  return {
    pageIndex: zeroBased ? Math.min(lastRead, count - 1) : lastRead - 1,
    snapshot: true,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

export function unavailableProgressEndpoint(error: unknown): boolean {
  if (!(error instanceof OpdsError)) return false;
  if (error.code === 'access-denied') return true;
  return ['invalid-catalog', 'unsupported', 'network'].includes(error.code);
}

function kavitaRoot(connection: PrivateConnection) {
  if (connection.auth.kind !== 'url-token') return;
  const url = new URL(connection.root);
  const route = /^(.*)\/api\/opds\/([^/]+)\/?$/i.exec(url.pathname);
  if (!route) return;
  try {
    return { origin: url.origin, prefix: route[1], token: decodeURIComponent(route[2]) };
  } catch {
    return;
  }
}

/** Provider-local protocol profiles; no server brand or private endpoint reaches the public contract. */
export function discoverProgressBinding(
  connection: PrivateConnection,
  publication: OpdsPublication,
  opening: ProgressOpening,
): OpdsProgressBinding | null {
  const root = kavitaRoot(connection);
  if (root && opening.template) {
    const url = new URL(opening.template.href);
    const route = /^(.*)\/api\/opds\/([^/]+)\/image\/?$/i.exec(url.pathname);
    if (route && url.origin === root.origin && route[1] === root.prefix) {
      let token: string;
      try {
        token = decodeURIComponent(route[2]);
      } catch {
        return null;
      }
      const fields = ['chapterId', 'volumeId', 'seriesId', 'libraryId'] as const;
      const values = fields.map((field) => {
        const value = url.searchParams.get(field);
        return url.searchParams.getAll(field).length === 1 && value && /^\d+$/.test(value)
          ? Number(value)
          : NaN;
      });
      if (
        token === root.token &&
        values.every((value) => integer(value) && value > 0) &&
        url.searchParams.getAll('pageNumber').length === 1 &&
        url.searchParams.get('pageNumber') === '{pageNumber}'
      ) {
        return {
          kind: 'kavita',
          prefix: root.prefix,
          chapterId: values[0],
          volumeId: values[1],
          seriesId: values[2],
          libraryId: values[3],
        };
      }
    }
  }
  const link = publication.links.find(
    (link) =>
      hasRel(link, 'http://www.cantook.com/api/progression') &&
      mediaType(link.type) === 'application/vnd.readium.progression+json' &&
      !link.indirect &&
      !link.encrypted,
  );
  return link ? { kind: 'readium', url: allowedUrl(connection, link.href) } : null;
}

function kavitaUrl(
  connection: PrivateConnection,
  binding: KavitaProgressBinding,
  endpoint: string,
) {
  const root = kavitaRoot(connection);
  if (!root || root.prefix !== binding.prefix)
    throw new OpdsError('source-changed', 'OPDS 阅读进度绑定已改变，请重新打开。');
  const url = new URL(`${root.prefix}/api/Reader/${endpoint}`, root.origin);
  url.searchParams.set('apiKey', root.token);
  return url;
}

export function originalPageUrl(
  connection: PrivateConnection,
  binding: OpdsProgressBinding | null | undefined,
  ordinal: number,
): string | undefined {
  if (binding?.kind !== 'kavita') return;
  if (!binding.verified) throw invalidProgress();
  const url = kavitaUrl(connection, binding, 'image');
  url.searchParams.set('chapterId', String(binding.chapterId));
  url.searchParams.set('page', String(ordinal));
  url.searchParams.set('extractPdf', 'true');
  return url.href;
}

/** A document locator is internal to an EPUB, never a private transport URL. */
function epubHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4096) return;
  try {
    const decoded = decodeURIComponent(value);
    if (/^[\/\\]|[\u0000-\u001f\\]|^[^/]*:/.test(decoded) || decoded.split('/').includes('..'))
      return;
    return value;
  } catch {
    return;
  }
}

export async function readOpdsProgress(
  transport: OpdsTransport,
  connection: PrivateConnection,
  binding: OpdsProgressBinding,
  opening: ProgressOpening,
  signal?: AbortSignal,
): Promise<SourceReadingProgress | undefined> {
  const url =
    binding.kind === 'kavita'
      ? kavitaUrl(connection, binding, 'get-progress')
      : new URL(binding.url);
  if (binding.kind === 'kavita') url.searchParams.set('chapterId', String(binding.chapterId));
  const response = await transport.bytes(connection, url.href, { signal, maxBytes: 128 * 1024 });
  if (binding.kind === 'readium' && response.status === 204) return;
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(new TextDecoder().decode(response.bytes)));
  } catch {
    throw invalidProgress();
  }
  if (binding.kind === 'kavita') {
    if (value.chapterId !== binding.chapterId || !integer(value.pageNum)) throw invalidProgress();
    for (const field of ['volumeId', 'seriesId', 'libraryId'] as const) {
      if (value[field] !== 0 && value[field] !== binding[field]) throw invalidProgress();
    }
    const count = opening.template?.count ?? opening.pages?.length;
    if (!count || value.pageNum > count) throw invalidProgress();
    // Kavita's API and its PSE lastRead expose the same zero-based PageNum, unlike generic PSE.
    return {
      pageIndex: Math.min(value.pageNum, count - 1),
      updatedAt: modifiedAt(value.lastModifiedUtc),
    };
  }
  const locator = object(value.locator),
    locations = object(locator.locations);
  const updatedAt = modifiedAt(value.modified);
  if (opening.format !== 'epub') {
    const count = opening.pages?.length ?? opening.template?.count;
    if (
      !integer(locations.position) ||
      !locations.position ||
      (count && locations.position > count)
    )
      return;
    return { pageIndex: locations.position - 1, updatedAt };
  }
  const href = epubHref(locator.href);
  if (!href) return;
  const fragments = Array.isArray(locations.fragments)
    ? locations.fragments.filter(
        (value): value is string => typeof value === 'string' && value.length <= 8192,
      )
    : [];
  const cfi = fragments.find((value) => /^epubcfi\(.*\)$/.test(value));
  const fragment = fragments.find((value) => !value.startsWith('epubcfi('));
  return {
    documentLocation: {
      href: fragment && !href.includes('#') ? `${href}#${fragment}` : href,
      ...(cfi ? { cfi } : {}),
      ...(fraction(locations.progression) ? { progression: locations.progression } : {}),
      ...(fraction(locations.totalProgression)
        ? { totalProgression: locations.totalProgression }
        : {}),
    },
    updatedAt,
  };
}

export async function writeOpdsProgress(
  transport: OpdsTransport,
  connection: PrivateConnection,
  binding: OpdsProgressBinding,
  opening: ProgressOpening,
  progress: SourceReadingProgress,
  signal?: AbortSignal,
): Promise<void> {
  if (binding.kind === 'kavita') {
    const count = opening.template?.count ?? opening.pages?.length;
    if (!binding.verified || !integer(progress.pageIndex) || !count || progress.pageIndex >= count)
      throw invalidProgress();
    await transport.writeProgress(
      connection,
      {
        url: kavitaUrl(connection, binding, 'progress').href,
        method: 'POST',
        [progressTarget]: true,
      },
      {
        chapterId: binding.chapterId,
        volumeId: binding.volumeId,
        seriesId: binding.seriesId,
        libraryId: binding.libraryId,
        pageNum: progress.pageIndex,
      },
      signal,
    );
    return;
  }
  let locator: Record<string, unknown>;
  if (opening.format === 'epub') {
    const location = progress.documentLocation;
    const href = epubHref(location?.href);
    if (!location || !href || !fraction(location.progression)) throw invalidProgress();
    const [resource, fragment] = href.split('#', 2);
    const cfi =
      location.cfi && location.cfi.length <= 8192 && /^epubcfi\(.*\)$/.test(location.cfi)
        ? location.cfi
        : undefined;
    locator = {
      href: resource,
      type: 'application/xhtml+xml',
      locations: {
        progression: location.progression,
        fragments: [cfi, fragment].filter(Boolean),
        ...(fraction(location.totalProgression)
          ? { totalProgression: location.totalProgression }
          : {}),
      },
    };
  } else {
    const count = opening.pages?.length ?? opening.template?.count;
    if (!integer(progress.pageIndex) || (count && progress.pageIndex >= count))
      throw invalidProgress();
    const page = opening.pages?.[progress.pageIndex];
    locator = {
      href: page?.href ?? '',
      type: page?.type ?? 'image/jpeg',
      locations: { position: progress.pageIndex + 1 },
    };
  }
  const updatedAt = progress.updatedAt ?? Date.now();
  if (!Number.isFinite(updatedAt) || !Number.isFinite(new Date(updatedAt).getTime()))
    throw invalidProgress();
  await transport.writeProgress(
    connection,
    {
      url: binding.url,
      method: 'PUT',
      [progressTarget]: true,
    },
    {
      modified: new Date(updatedAt).toISOString(),
      device: { id: connection.id, name: 'Node Comics' },
      locator,
    },
    signal,
  );
}
