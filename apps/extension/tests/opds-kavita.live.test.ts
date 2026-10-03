import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { SourceConnection } from '../src/comics/domain';
import type {
  RemoteCatalogPage,
  RemotePublication,
  SourceAccount,
  SourceProvider,
} from '../src/comics/sources/contracts';
import { createOpdsProvider } from '../src/comics/sources/opds/provider';
import { PrivateOpdsStore } from '../src/comics/sources/opds/private-store';
import { OpdsError } from '../src/comics/sources/opds/errors';
import { readBounded } from '../src/comics/sources/opds/transport';
import { imageMimeFromBytes } from '../src/comics/formats/identify';
import { installTestXmlParser } from './opds-protocol-dom';

installTestXmlParser();

const ORIGIN = 'https://demo.kavitareader.com';
const nativeFetch = globalThis.fetch.bind(globalThis);
const query = 'Captain Marvel';

class LiveFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new LiveFailure(code);
}

function publicConnection(account: SourceAccount): SourceConnection {
  return { ...account, generation: 1, createdAt: 1, updatedAt: 1 };
}

async function jsonResponse(response: Response): Promise<unknown> {
  check(response.ok, 'bootstrap-http-' + response.status);
  const text = new TextDecoder().decode(await readBounded(response, 128 * 1024));
  try {
    return JSON.parse(text);
  } catch {
    if (text.startsWith(ORIGIN + '/')) return text;
    throw new LiveFailure('bootstrap-response-shape');
  }
}

async function connectUrl(): Promise<string> {
  // These are the demo credentials publicly documented by Kavita, not a private test account.
  // Login is the sole POST; it neither creates an OPDS key nor changes any server settings.
  const login = await nativeFetch(ORIGIN + '/api/Account/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demouser', password: 'Demouser64' }),
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(30000),
  });
  const value = await jsonResponse(login);
  check(
    value && typeof value === 'object' && 'token' in value && typeof value.token === 'string',
    'bootstrap-token-shape',
  );
  const address = await jsonResponse(
    await nativeFetch(ORIGIN + '/api/Account/opds-url', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + value.token },
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(30000),
    }),
  );
  const url =
    typeof address === 'string'
      ? address
      : address &&
          typeof address === 'object' &&
          'url' in address &&
          typeof address.url === 'string'
        ? address.url
        : undefined;
  check(url && new URL(url).origin === ORIGIN, 'bootstrap-opds-url-shape');
  return url;
}

async function findComic(
  provider: SourceProvider,
  account: SourceAccount,
): Promise<{ publication: RemotePublication; feeds: number }> {
  const connection = publicConnection(account);
  const initial = await provider.catalog!.browse({ connection });
  const pending: { location?: string; search?: string; matching: boolean }[] = initial.searchable
    ? [{ search: query, matching: true }]
    : [{ matching: false }];
  const seen = new Set<string>();
  let feeds = 1;
  const entries = (page: RemoteCatalogPage) => [
    ...page.publications,
    ...(page.groups ?? []).flatMap((group) => group.publications),
  ];
  while (pending.length && feeds < 16) {
    const next = pending.shift()!;
    const key = JSON.stringify([next.location, next.search]);
    if (seen.has(key)) continue;
    seen.add(key);
    const page = await provider.catalog!.browse({
      connection,
      location: next.location,
      search: next.search,
    });
    feeds++;
    const candidates = entries(page).filter(
      (publication) => next.matching || /captain\s+marvel/i.test(publication.title),
    );
    const publication = candidates.find((item) => item.formats?.includes('cbz'));
    if (publication) return { publication, feeds };
    const links = [
      ...page.navigation,
      ...(page.groups ?? []).flatMap((group) => group.navigation),
    ].sort(
      (a, b) =>
        Number(/captain\s+marvel/i.test(b.title)) - Number(/captain\s+marvel/i.test(a.title)),
    );
    for (const link of links.slice(0, 6)) {
      if (pending.length >= 32) break;
      pending.push({
        location: link.location,
        matching: next.matching || /captain\s+marvel/i.test(link.title),
      });
    }
    if (page.next && pending.length < 32)
      pending.push({ location: page.next, matching: next.matching });
  }
  throw new LiveFailure('no-cbz-sample-within-bounded-search');
}

async function imageSignature(blob: Blob, code: string): Promise<string> {
  const type = imageMimeFromBytes(new Uint8Array(await blob.slice(0, 80).arrayBuffer()));
  check(type, code);
  return type;
}

describe.skipIf(process.env.RUN_OPDS_LIVE_KAVITA !== '1')(
  'official Kavita demo (real network)',
  () => {
    let reads = 0;
    let blockedProgressRequests = 0;
    let lastRequest: { kind: string; range: boolean; status: number } | undefined;
    let values: Record<string, string>;
    let first: SourceAccount;
    let selected: Awaited<ReturnType<typeof findComic>>;
    const accounts: SourceAccount[] = [];
    const store = new PrivateOpdsStore('opds-live-kavita-' + crypto.randomUUID());
    const guardedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      check(url.origin === ORIGIN, 'cross-origin-request-blocked');
      check(['GET', 'HEAD'].includes(request.method), 'opds-write-request-blocked');
      let path: string;
      try {
        // Independent, conservative guard: an encoded route must not bypass live-test safety.
        path = decodeURIComponent(url.pathname);
      } catch {
        throw new LiveFailure('invalid-path-encoding-blocked');
      }
      if (/\/api\/opds\/[^/]+\/image(?:\/|$)/i.test(path)) {
        blockedProgressRequests++;
        throw new LiveFailure('progress-writing-pse-request-blocked');
      }
      reads++;
      const response = await nativeFetch(request);
      const kind = request.headers.has('Range')
        ? 'file-range-probe'
        : /^\/api\/image(?:\/|$)/i.test(url.pathname)
          ? 'artwork'
          : 'catalog-or-detail';
      lastRequest = {
        kind,
        range: request.headers.has('Range'),
        status: response.status,
      };
      return response;
    };
    const provider = createOpdsProvider({ store, fetch: guardedFetch });

    function sanitizedFailure(stage: string, error: unknown): Error {
      const code =
        error instanceof OpdsError || error instanceof LiveFailure
          ? error.code
          : 'unexpected-error';
      const status = error instanceof OpdsError ? error.details.status : undefined;
      console.info(
        JSON.stringify({
          service: 'official-kavita-demo',
          passed: false,
          stage,
          code,
          status,
          lastRequest,
          opdsReads: reads,
          blockedProgressRequests,
        }),
      );
      return new Error(
        `Kavita live failed at ${stage}: ${code}${status ? ' (HTTP ' + status + ')' : ''}`,
      );
    }

    beforeAll(async () => {
      try {
        values = {
          name: 'Official Kavita demo',
          url: await connectUrl(),
          auth: 'url-token',
        };
        first = await provider.connection!.connect!(values);
        accounts.push(first);
        selected = await findComic(provider, first);
        check(selected.publication.artwork, 'selected-comic-has-no-cover');
        check(
          !JSON.stringify({ selected, first }).includes(values.url),
          'private-url-leaked-to-public-contract',
        );
      } catch (error) {
        throw sanitizedFailure('bootstrap-connect-and-search', error);
      }
    }, 60000);

    afterAll(async () => {
      const results = await Promise.allSettled(
        accounts.map((account) => provider.connection!.disconnect!(account)),
      );
      check(
        results.every((result) => result.status === 'fulfilled'),
        'private-credential-cleanup-failed',
      );
    });

    it('reads the real catalog and cover while keeping two connections isolated', async () => {
      try {
        const originalArtwork = selected.publication.artwork!;
        const cover = await provider.artwork!.read(publicConnection(first), originalArtwork);
        await imageSignature(cover, 'cover-signature-invalid');
        const second = await provider.connection!.connect!(values);
        accounts.push(second);
        const independent = await findComic(provider, second);
        check(
          second.id !== first.id && independent.publication.id !== selected.publication.id,
          'connection-publication-identity-collision',
        );
        check(
          independent.publication.artwork &&
            independent.publication.artwork.id !== originalArtwork.id,
          'connection-artwork-identity-collision',
        );
        const beforeCrossRead = reads;
        let rejected = false;
        try {
          await provider.artwork!.read(publicConnection(second), originalArtwork);
        } catch (error) {
          rejected = error instanceof OpdsError && error.code === 'source-changed';
        }
        check(
          rejected && reads === beforeCrossRead,
          'cross-connection-artwork-was-not-rejected-before-network',
        );
        await provider.connection!.disconnect!(second);
        await imageSignature(
          await provider.artwork!.read(publicConnection(first), originalArtwork),
          'independent-cover-after-disconnect-invalid',
        );
        console.info(
          JSON.stringify({
            service: 'official-kavita-demo',
            check: 'catalog-cover-connection-isolation',
            passed: true,
            feeds: selected.feeds,
            coverBytes: cover.size,
            isolatedConnections: 2,
          }),
        );
      } catch (error) {
        throw sanitizedFailure('catalog-cover-connection-isolation', error);
      }
    }, 60000);

    it('reports the demo file-access denial without a progress-writing PSE fallback', async () => {
      try {
        let denied = false;
        try {
          // Exactly one known acquisition candidate: never try other routes to bypass a denial.
          await provider.catalog!.resolve(publicConnection(first), selected.publication.id);
        } catch (error) {
          if (!(
            error instanceof OpdsError &&
            error.code === 'authentication-required' &&
            error.details.status === 403
          ))
            throw error;
          denied = true;
        }
        check(denied, 'demo-download-permission-changed-requires-new-reading-verification');
        check(
          lastRequest?.kind === 'file-range-probe' && blockedProgressRequests === 0,
          'unexpected-acquisition-denial',
        );
        // This is an authorization-refusal test, not evidence of successful file reading or pinned-cover recovery.
        console.info(
          JSON.stringify({
            service: 'official-kavita-demo',
            check: 'acquisition-permission',
            permissionDeniedVerified: true,
            httpStatus: 403,
            fileReadingVerified: false,
            coverReconnectVerified: false,
            bootstrapPosts: 1,
            opdsReads: reads,
            blockedProgressRequests,
          }),
        );
      } catch (error) {
        // Never let Vitest serialize a native response, request, URL, credential or unsanitized cause.
        throw sanitizedFailure('acquisition-permission', error);
      }
    }, 60000);
  },
);
