import { openSourceDatabase } from '../../../storage/database';
import type { OpdsPublication } from './protocol';
import { OpdsError } from './errors';

export type OpdsAuth =
  | { kind: 'anonymous' }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'url-token' };
export interface PrivateConnection {
  id: string;
  name: string;
  root: string;
  auth: OpdsAuth;
  revision: number;
  namespace: string;
  createdAt: number;
  disconnected?: boolean;
  origin?: string;
  endpointKey?: string;
  accountKey?: string;
}
export interface PrivateResource {
  id: string;
  connectionId: string;
  revision: number;
  kind: 'catalog' | 'publication' | 'opening' | 'artwork';
  value: Record<string, unknown>;
  pinned?: boolean;
  updatedAt: number;
}
export interface PublicationResource extends PrivateResource {
  kind: 'publication';
  value: { publication: OpdsPublication; protocol: string };
}
export interface OpdsStore {
  connections(): Promise<PrivateConnection[]>;
  connection(id: string): Promise<PrivateConnection | undefined>;
  saveConnection(
    value: PrivateConnection,
    expected?: Pick<PrivateConnection, 'revision' | 'disconnected'>,
    signal?: AbortSignal,
  ): Promise<void>;
  resource(id: string): Promise<PrivateResource | undefined>;
  saveResources(values: PrivateResource[]): Promise<void>;
  disconnect(id: string): Promise<void>;
  clearTransient?(connectionId: string): void;
}
const credentialKey = (key: string) => /^(?:api_?key|token|access_token|auth|password)$/i.test(key);
const pathCredential = /(\/api\/opds\/)([^/]+)(?=\/|$)/i;
const pathPlaceholder = '__opds_path_credential__';
const queryPlaceholder = '__opds_query_credential__';
const pathToken = (url?: URL) => url?.pathname.match(pathCredential)?.[2];
function decodedToken(value?: string): string | undefined {
  try {
    return value === undefined ? undefined : decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
function boundCredential(
  value: string | null | undefined,
  previous: string | null | undefined,
  placeholder: string,
  disconnected?: boolean,
): boolean {
  return (!!previous && value === previous) || (disconnected === true && value === placeholder);
}
/** Keep only reconstructible credential placeholders after disconnect, not signed URLs. */
function transformUrls(
  value: unknown,
  connection: PrivateConnection,
  replacement?: PrivateConnection,
): unknown {
  if (Array.isArray(value)) return value.map((v) => transformUrls(v, connection, replacement));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (
        ['href', 'url', 'catalogUrl', 'identity'].includes(key) &&
        typeof item === 'string' &&
        /^https?:/.test(item)
      ) {
        const url = new URL(item),
          newRoot = replacement ? new URL(replacement.root) : undefined,
          oldRoot = connection.root ? new URL(connection.root) : undefined;
        if (url.origin !== (connection.origin ?? oldRoot?.origin))
          return [key, 'opds-unavailable:external-resource'];
        let usesBoundQuery = false;
        for (const name of [...url.searchParams.keys()]) {
          if (/^(?:sig(?:nature)?|expires|x-amz-.+|x-goog-.+)$/i.test(name))
            return [key, 'opds-unavailable:expired-signature'];
          if (credentialKey(name)) {
            // Kavita advertises the same key in the OPDS path and artwork's apiKey query.
            // Preserve that proven binding, not an arbitrary credential found in a feed.
            const fromPath =
              connection.auth.kind === 'url-token' &&
              name.toLowerCase() === 'apikey' &&
              boundCredential(
                url.searchParams.get(name),
                decodedToken(pathToken(oldRoot)),
                pathPlaceholder,
                connection.disconnected,
              );
            const fromQuery = boundCredential(
              url.searchParams.get(name),
              oldRoot?.searchParams.get(name),
              queryPlaceholder,
              connection.disconnected,
            );
            if (!fromPath && !fromQuery) return [key, 'opds-unavailable:credential-refresh'];
            const newValue = fromPath
              ? decodedToken(pathToken(newRoot))
              : newRoot?.searchParams.get(name);
            if (replacement && !newValue) return [key, 'opds-unavailable:credential-refresh'];
            url.searchParams.set(name, newValue ?? (fromPath ? pathPlaceholder : queryPlaceholder));
            usesBoundQuery = true;
          }
        }
        const resourceToken = pathToken(url);
        if (resourceToken) {
          if (
            !boundCredential(
              decodedToken(resourceToken),
              decodedToken(pathToken(oldRoot)),
              pathPlaceholder,
              connection.disconnected,
            )
          )
            return [key, 'opds-unavailable:credential-refresh'];
          const newToken = pathToken(newRoot);
          if (replacement && !newToken) return [key, 'opds-unavailable:credential-refresh'];
          url.pathname = url.pathname.replace(
            pathCredential,
            (_match, prefix: string) => prefix + (newToken ?? pathPlaceholder),
          );
        }
        if (
          connection.auth.kind === 'url-token' &&
          !resourceToken &&
          !usesBoundQuery &&
          ![...((oldRoot ?? newRoot)?.searchParams.keys() ?? [])].some(credentialKey)
        )
          return [key, 'opds-unavailable:credential-refresh'];
        return [key, url.href.replace(/%7B/gi, '{').replace(/%7D/gi, '}')];
      }
      return [key, transformUrls(item, connection, replacement)];
    }),
  );
}
/** Provider-owned database. Never exported through catalog, account metadata, backups or sync. */
export class PrivateOpdsStore implements OpdsStore {
  private pending?: Promise<IDBDatabase>;
  private transient = new Map<string, PrivateResource>();
  constructor(private readonly databaseName = 'opds-private') {}
  private database() {
    return (this.pending ??= openSourceDatabase(
      this.databaseName,
      {
        connections: { keyPath: 'id' },
        resources: {
          keyPath: 'id',
          indexes: [{ name: 'connectionId', keyPath: 'connectionId' }],
        },
      },
      () => {
        this.pending = undefined;
      },
    ).catch((error) => {
      this.pending = undefined;
      throw error;
    }));
  }
  private async request<T>(
    store: string,
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode),
        req = run(tx.objectStore(store));
      let result: T;
      req.onsuccess = () => {
        result = req.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  connections() {
    return this.request('connections', 'readonly', (s) => s.getAll()) as Promise<
      PrivateConnection[]
    >;
  }
  connection(id: string) {
    return this.request('connections', 'readonly', (s) => s.get(id)) as Promise<
      PrivateConnection | undefined
    >;
  }
  clearTransient(id: string) {
    for (const [key, row] of this.transient)
      if (row.connectionId === id) this.transient.delete(key);
  }
  async saveConnection(
    value: PrivateConnection,
    expected?: Pick<PrivateConnection, 'revision' | 'disconnected'>,
    signal?: AbortSignal,
  ) {
    const db = await this.database();
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['connections', 'resources'], 'readwrite');
      let failure: unknown;
      const cancel = () => {
        failure = signal?.reason;
        try {
          tx.abort();
        } catch {
          /* Already committed. */
        }
      };
      const finish = () => signal?.removeEventListener('abort', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      const current = tx.objectStore('connections').get(value.id);
      current.onsuccess = () => {
        try {
          signal?.throwIfAborted();
          const previous = current.result as PrivateConnection | undefined;
          // Authorization revocation and credential replacement share one IDB transaction/CAS.
          if (
            expected
              ? !previous ||
                previous.revision !== expected.revision ||
                !!previous.disconnected !== !!expected.disconnected
              : !!previous
          )
            throw new OpdsError('disconnected', 'OPDS 授权已在其他页面变更，请重新连接。');
          tx.objectStore('connections').put(value);
          if (previous) {
            const request = tx
              .objectStore('resources')
              .index('connectionId')
              .openCursor(IDBKeyRange.only(value.id));
            request.onsuccess = () => {
              try {
                signal?.throwIfAborted();
                const cursor = request.result;
                if (cursor) {
                  const row = cursor.value as PrivateResource;
                  cursor.update({
                    ...row,
                    revision: value.revision,
                    value: transformUrls(row.value, previous, value),
                  });
                  cursor.continue();
                }
              } catch (error) {
                failure = error;
                tx.abort();
              }
            };
          }
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        finish();
        this.clearTransient(value.id);
        resolve();
      };
      tx.onerror = () => {
        finish();
        reject(failure ?? tx.error);
      };
      tx.onabort = () => {
        finish();
        reject(failure ?? tx.error);
      };
    });
  }
  async resource(id: string) {
    const cached = this.transient.get(id);
    if (cached) {
      this.transient.delete(id);
      this.transient.set(id, cached);
      return structuredClone(cached);
    }
    return this.request('resources', 'readonly', (s) => s.get(id)) as Promise<
      PrivateResource | undefined
    >;
  }
  async saveResources(values: PrivateResource[]) {
    if (!values.length) return;
    const resources = values.map((value) => structuredClone(value));
    const revisions = new Map<string, number>();
    for (const value of resources) {
      const revision = revisions.get(value.connectionId);
      if (revision !== undefined && revision !== value.revision)
        throw new OpdsError('disconnected', 'OPDS 连接授权已变更，请重新打开。');
      revisions.set(value.connectionId, value.revision);
    }
    const pinned = resources.filter((value) => value.pinned);
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        ['connections', 'resources'],
        pinned.length ? 'readwrite' : 'readonly',
      );
      let remaining = revisions.size;
      let failure: unknown;
      for (const [id, revision] of revisions) {
        const request = tx.objectStore('connections').get(id);
        request.onsuccess = () => {
          try {
            const connection = request.result as PrivateConnection | undefined;
            if (!connection || connection.disconnected || connection.revision !== revision)
              throw new OpdsError('disconnected', 'OPDS 连接授权已变更，请重新打开。');
            if (--remaining === 0)
              for (const value of pinned) tx.objectStore('resources').put(value);
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
      }
      tx.oncomplete = () => {
        // Publish transient records only after the same authorization fence as pinned records.
        for (const value of resources) {
          this.transient.delete(value.id);
          this.transient.set(value.id, value);
        }
        while (this.transient.size > 2000)
          this.transient.delete(this.transient.keys().next().value!);
        resolve();
      };
      tx.onerror = () => reject(failure ?? tx.error);
      tx.onabort = () => reject(failure ?? tx.error);
    });
  }
  async disconnect(id: string) {
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['connections', 'resources'], 'readwrite');
      let failure: unknown;
      const current = tx.objectStore('connections').get(id);
      current.onsuccess = () => {
        try {
          const connection = current.result as PrivateConnection | undefined;
          if (connection)
            tx.objectStore('connections').put({
              ...connection,
              root: '',
              auth:
                connection.auth.kind === 'basic'
                  ? { kind: 'basic', username: '', password: '' }
                  : connection.auth,
              revision: connection.revision + 1,
              disconnected: true,
            });
          const request = tx
            .objectStore('resources')
            .index('connectionId')
            .openCursor(IDBKeyRange.only(id));
          request.onsuccess = () => {
            try {
              const cursor = request.result;
              if (cursor) {
                const row = cursor.value as PrivateResource;
                if (connection && row.pinned)
                  cursor.update({
                    ...row,
                    revision: connection.revision + 1,
                    value: transformUrls(row.value, connection),
                  });
                else cursor.delete();
                cursor.continue();
              }
            } catch (error) {
              failure = error;
              tx.abort();
            }
          };
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        this.clearTransient(id);
        resolve();
      };
      tx.onerror = () => reject(failure ?? tx.error);
      tx.onabort = () => reject(failure ?? tx.error);
    });
  }
}
export async function opaqueId(connectionId: string, kind: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${connectionId}\0${kind}\0${value}`),
    hash = await crypto.subtle.digest('SHA-256', bytes);
  return `opds:${kind}:${Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('')}`;
}
/** Only known credential positions are excluded; never merge arbitrary query/path variants. */
export function identityUrl(value: string, connection: PrivateConnection): string {
  if (connection.auth.kind !== 'url-token') return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.origin !== new URL(connection.root).origin) return value;
  for (const key of [...url.searchParams.keys()])
    if (/^(?:api_?key|token|access_token|auth|password)$/i.test(key))
      url.searchParams.set(key, '[credential]');
  url.pathname = url.pathname.replace(pathCredential, '$1[credential]');
  return url.href;
}
