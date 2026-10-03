import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { PageDescriptor, SourceConnection } from '../src/comics/domain';
import type {
  PageSourceContext,
  PageSourceIndex,
  RemoteCatalogPage,
  RemotePublication,
  RemoteReadingPlan,
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

function report(value: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(value) + '\n');
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
  const configured = process.env.OPDS_KAVITA_URL;
  if (configured) {
    const url = new URL(configured);
    check(url.origin === ORIGIN && !url.username && !url.password, 'configured-url-outside-demo');
    return url.href;
  }
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

function pageContext(account: SourceAccount, plan: RemoteReadingPlan): PageSourceContext {
  return {
    connection: publicConnection(account),
    source: {
      connectionId: account.id,
      providerItemId: plan.publication.id,
      locator: plan.locator,
      generation: 1,
      status: 'active',
    },
    entryId: `entry:${account.id}`,
    contentId: `content:${account.id}`,
    sourceSnapshot: plan.snapshot,
    format: plan.format,
  };
}

function pageDescriptor(
  context: PageSourceContext,
  page: PageSourceIndex['pages'][number],
): PageDescriptor {
  return {
    ...page,
    pageId: `page:${context.connection.id}:${page.ordinal}`,
    contentId: context.contentId,
    formatLocator: 'opds',
  };
}

describe.skipIf(process.env.RUN_OPDS_LIVE_KAVITA !== '1')(
  'official Kavita demo (real network)',
  () => {
    let reads = 0;
    const pageRequests: number[] = [];
    let progressWrites = 0;
    let lastRequest: { kind: string; range: boolean; status: number } | undefined;
    let values: Record<string, string>;
    let first: SourceAccount;
    let selected: Awaited<ReturnType<typeof findComic>>;
    const accounts: SourceAccount[] = [];
    const databaseName = 'opds-live-kavita-' + crypto.randomUUID();
    const store = new PrivateOpdsStore(databaseName);
    const guardedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      check(url.origin === ORIGIN, 'cross-origin-request-blocked');
      const progressWrite = request.method === 'POST' && url.pathname === '/api/Reader/progress';
      check(
        ['GET', 'HEAD'].includes(request.method) || progressWrite,
        'opds-write-request-blocked',
      );
      if (progressWrite) {
        check(progressWrites < 2, 'progress-write-budget-exceeded');
        progressWrites++;
      }
      check(!request.headers.has('User-Agent'), 'reader-user-agent-override-blocked');
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        throw new LiveFailure('invalid-path-encoding-blocked');
      }
      if (/\/api\/opds\/[^/]+\/image(?:\/|$)/i.test(path)) {
        throw new LiveFailure('progress-writing-image-route-must-not-be-used');
      }
      if (path === '/api/Reader/image') {
        const page = Number(url.searchParams.get('page'));
        check([0, 1].includes(page) && pageRequests.length < 2, 'page-request-budget-exceeded');
        check(
          !url.searchParams.has('maxWidth') && !url.searchParams.has('maxHeight'),
          'unexpected-image-resizing',
        );
        pageRequests.push(page);
      }
      reads++;
      const response = await nativeFetch(request);
      const kind = request.headers.has('Range')
        ? 'file-range-probe'
        : path === '/api/Reader/image'
          ? 'page-image'
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
          pageRequests,
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

    it('indexes and reads two real PSE pages across reconnect with isolated connections', async () => {
      try {
        const originalArtwork = selected.publication.artwork!;
        const plan = await provider.catalog!.resolve(
          publicConnection(first),
          selected.publication.id,
        );
        check(
          plan.kind === 'pages' && plan.format === 'image-sequence',
          'advertised-pse-not-selected',
        );
        const context = pageContext(first, plan);
        const beforeIndex = reads;
        const index = await provider.pages!.index(context);
        check(
          index.complete && index.pages.length >= 2 && index.total === index.pages.length,
          'incomplete-pse-index',
        );
        check(reads === beforeIndex && pageRequests.length === 0, 'index-requested-page-images');
        check(
          index.pages.every((page, ordinal) => page.ordinal === ordinal),
          'pse-index-is-not-zero-based',
        );
        const firstPage = pageDescriptor(context, index.pages[0]);
        const nextPage = pageDescriptor(context, index.pages[1]);
        const originalProgress = await provider.progress!.read(context);
        check(
          originalProgress && Number.isInteger(originalProgress.pageIndex),
          'server-progress-unavailable',
        );
        const image = await provider.pages!.read(context, firstPage);
        const firstMime = await imageSignature(image, 'first-page-signature-invalid');
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
        const secondPlan = await provider.catalog!.resolve(
          publicConnection(second),
          independent.publication.id,
        );
        check(
          secondPlan.kind === 'pages' && secondPlan.representationId !== plan.representationId,
          'connection-opening-identity-collision',
        );
        const secondContext = pageContext(second, secondPlan);
        const secondIndex = await provider.pages!.index(secondContext);
        check(secondIndex.total === index.total, 'connection-page-index-mismatch');
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
        rejected = false;
        try {
          await provider.pages!.read(secondContext, firstPage);
        } catch (error) {
          rejected = error instanceof OpdsError && error.code === 'source-changed';
        }
        check(
          rejected && reads === beforeCrossRead,
          'cross-connection-page-was-not-rejected-before-network',
        );
        rejected = false;
        try {
          await provider.progress!.write(
            { ...context, connection: publicConnection(second) },
            { pageIndex: 1 },
          );
        } catch (error) {
          rejected = error instanceof OpdsError && error.code === 'source-changed';
        }
        check(
          rejected && reads === beforeCrossRead,
          'cross-connection-progress-was-not-rejected-before-network',
        );

        await provider.connection!.disconnect!(first);
        const beforeDisconnectedRead = reads;
        rejected = false;
        try {
          await provider.pages!.read(context, nextPage);
        } catch (error) {
          rejected = error instanceof OpdsError && error.code === 'disconnected';
        }
        check(
          rejected && reads === beforeDisconnectedRead,
          'disconnected-page-was-not-rejected-before-network',
        );
        rejected = false;
        try {
          await provider.progress!.write(context, { pageIndex: 1 });
        } catch (error) {
          rejected = error instanceof OpdsError && error.code === 'disconnected';
        }
        check(
          rejected && reads === beforeDisconnectedRead,
          'disconnected-progress-was-not-rejected-before-network',
        );
        check(
          (await provider.pages!.index(secondContext)).total === index.total,
          'disconnect-affected-other-connection',
        );
        await imageSignature(
          await provider.artwork!.read(publicConnection(second), independent.publication.artwork!),
          'independent-cover-after-disconnect-invalid',
        );

        const restored = await provider.connection!.connect!(values, first);
        check(restored.id === first.id, 'reconnect-changed-connection-identity');
        await provider.connection!.disconnect!(second);
        // Use a new store instance so the old pinned plan cannot pass using an in-memory URL.
        const reloaded = createOpdsProvider({
          store: new PrivateOpdsStore(databaseName),
          fetch: guardedFetch,
        });
        const restoredIndex = await reloaded.pages!.index(context);
        check(restoredIndex.total === index.total, 'reconnect-changed-page-index');
        const nextImage = await reloaded.pages!.read(context, nextPage);
        const nextMime = await imageSignature(
          nextImage,
          'next-page-after-reconnect-signature-invalid',
        );
        const cover = await reloaded.artwork!.read(publicConnection(restored), originalArtwork);
        await imageSignature(cover, 'pinned-cover-after-reconnect-signature-invalid');
        check(pageRequests.join(',') === '0,1', 'unexpected-page-sequence');
        const afterImages = await reloaded.progress!.read(context);
        check(
          afterImages?.pageIndex === originalProgress.pageIndex && progressWrites === 0,
          'page-reading-changed-progress',
        );
        check(
          !JSON.stringify({ plan, index, secondPlan }).includes(values.url),
          'private-url-leaked-to-reading-contract',
        );
        console.info(
          JSON.stringify({
            service: 'official-kavita-demo',
            check: 'pse-reading-reconnect-connection-isolation',
            passed: true,
            feeds: selected.feeds,
            indexedPages: index.total,
            pageRequests,
            imageBytes: [image.size, nextImage.size],
            imageMime: [firstMime, nextMime],
            coverBytes: cover.size,
            isolatedConnections: 2,
            reconnectVerified: true,
            progressUnchanged: true,
          }),
        );
      } catch (error) {
        throw sanitizedFailure('pse-reading-reconnect-connection-isolation', error);
      }
    }, 60000);

    it('keeps the demo full-file permission denial separate from permitted page reading', async () => {
      try {
        const pagesBeforeDownload = pageRequests.length;
        let denied = false;
        try {
          // Exactly one known acquisition candidate: never try other routes to bypass a denial.
          await provider.catalog!.resolve(publicConnection(first), selected.publication.id, {
            purpose: 'download',
          });
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
          lastRequest?.kind === 'file-range-probe' && pageRequests.length === pagesBeforeDownload,
          'unexpected-acquisition-denial',
        );
        // PSE authorization does not authorize full-file downloads or bypass their 403 response.
        console.info(
          JSON.stringify({
            service: 'official-kavita-demo',
            check: 'acquisition-permission',
            permissionDeniedVerified: true,
            httpStatus: 403,
            fileReadingVerified: false,
            bootstrapPosts: process.env.OPDS_KAVITA_URL ? 0 : 1,
            opdsReads: reads,
            pageRequests,
          }),
        );
      } catch (error) {
        // Never let Vitest serialize a native response, request, URL, credential or unsanitized cause.
        throw sanitizedFailure('acquisition-permission', error);
      }
    }, 60000);

    it('round-trips an explicit page position through the provider and restores the demo position', async () => {
      try {
        const plan = await provider.catalog!.resolve(
          publicConnection(first),
          selected.publication.id,
        );
        const context = pageContext(first, plan);
        const before = await provider.progress!.read(context);
        check(before && typeof before.pageIndex === 'number', 'reader-progress-unavailable');
        const target = before.pageIndex === 1 ? 2 : 1;
        try {
          await provider.progress!.write(context, { pageIndex: target, updatedAt: Date.now() });
          const reloaded = createOpdsProvider({
            store: new PrivateOpdsStore(databaseName),
            fetch: guardedFetch,
          });
          const after = await reloaded.progress!.read(context);
          check(after?.pageIndex === target, 'reader-progress-write-not-visible-to-new-provider');
        } finally {
          await provider.progress!.write(context, {
            pageIndex: before.pageIndex,
            updatedAt: Date.now(),
          });
        }
        check(
          (await provider.progress!.read(context))?.pageIndex === before.pageIndex,
          'reader-progress-restore-failed',
        );
        report({
          service: 'official-kavita-demo',
          check: 'provider-reading-progress-roundtrip',
          passed: true,
          targetPageIndex: target,
          restoredPageIndex: before.pageIndex,
          progressWrites,
          pageRequests,
        });
      } catch (error) {
        throw sanitizedFailure('provider-reading-progress-roundtrip', error);
      }
    }, 60000);
  },
);
