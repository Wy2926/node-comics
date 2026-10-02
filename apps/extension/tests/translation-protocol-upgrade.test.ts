import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {sourceDatabaseName} from '../src/storage/database';
import {pageReference, RENDER_PROFILE, type PageReference} from '../src/comics/pages/identity';
import {TranslationCoordinator} from '../src/translation/channels/adapters/nodelane/coordinator';
import {makeOperation, operationId} from '../src/translation/channels/adapters/nodelane/operations';
import {readOperation, type LocalOperation} from '../src/translation/channels/adapters/nodelane/store';
import {fixture, originalBytes, originalInput, snapshot, target} from './translation-fixture';

afterEach(() => vi.restoreAllMocks());

async function legacyDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(sourceDatabaseName('translation-requests'), 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('operations', {keyPath: 'id'}).createIndex('scope', 'scope');
      open.result.createObjectStore('sync', {keyPath: 'id'});
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function seed(f: ReturnType<typeof fixture>, state: LocalOperation['state'] = 'uncertain') {
  const reference = {entryId: 'book', contentId: 'revision', pageId: 'page-0', renderProfileId: 'original-v1-gif-first-frame'};
  const oldTarget = {...target(0), page: {...target(0).page, ...reference, blobKey: pageReference(reference)}};
  const scope = JSON.stringify([new URL(f.api.base).origin, f.userId]);
  const record = makeOperation(oldTarget, scope, 'zh-Hans', originalInput(0));
  record.state = state;
  const database = await legacyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('operations', 'readwrite');
      tx.objectStore('operations').put(record);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { database.close(); }
  const current = {...oldTarget, page: {...oldTarget.page, renderProfileId: RENDER_PROFILE,
    blobKey: pageReference({...reference, renderProfileId: RENDER_PROFILE})}};
  return {record, current};
}

describe('overlay protocol upgrade receipts', () => {
  it('does not replay an old source reference or submit again while the accepted receipt needs input', async () => {
    const f = fixture(), {record, current} = await seed(f);
    vi.mocked(f.api.translations).mockResolvedValue({unchanged: false, etag: undefined, items: [snapshot(record.requestId, record.request, {state: 'needs_input'})], missing_ids: []});
    const readOriginal = vi.fn(), upload = vi.spyOn(f.api, 'translationInput');
    const core = new TranslationCoordinator({...f.core.options, readOriginal});
    await core.submit([current]);
    await core.finishUploads();
    expect(current.page.translationError).toContain('原请求结果待核实');
    expect(f.submit).not.toHaveBeenCalled();
    expect(readOriginal).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await expect(core.manual(current)).rejects.toMatchObject({code: 'LEGACY_REQUEST_PENDING'});
    expect(await readOperation(operationId(core.scope, 'zh-Hans', current))).toBeUndefined();
  });

  it('creates a current-profile operation only after the old UUID is explicitly reported missing', async () => {
    const f = fixture(), {record, current} = await seed(f);
    vi.mocked(f.api.translations).mockResolvedValue({unchanged: false, etag: undefined, items: [], missing_ids: [record.requestId]});
    f.submit.mockImplementation(async (id, body) => snapshot(id, body, {state: 'needs_input'}));
    const release = vi.fn(), readOriginal = vi.fn(async (_reference: PageReference) => ({blob: originalBytes(0), release}));
    const upload = vi.spyOn(f.api, 'translationInput').mockImplementation(async id => snapshot(id, record.request));
    const core = new TranslationCoordinator({...f.core.options, readOriginal});
    await core.submit([current]);
    await core.finishUploads();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0][0]).not.toBe(record.requestId);
    expect(readOriginal.mock.calls[0][0]).toMatchObject({renderProfileId: RENDER_PROFILE});
    expect(upload).toHaveBeenCalledOnce();
    expect((await readOperation(operationId(core.scope, 'zh-Hans', current)))?.pageRef?.renderProfileId).toBe(RENDER_PROFILE);
  });

  it.each(['failed', 'succeeded'] as const)('requires a manual action for an old %s page without reusing the old image descriptor', async state => {
    const f = fixture(), {record, current} = await seed(f, 'accepted');
    vi.mocked(f.api.translations).mockResolvedValue({unchanged: false, etag: undefined, items: [snapshot(record.requestId, record.request, {state})], missing_ids: []});
    await f.core.submit([current]);
    expect(f.submit).not.toHaveBeenCalled();
    expect(current.page.translationError).toContain('手动重新翻译');
    await f.core.manual(current);
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0][1]).toMatchObject({image: {normalization_version: 1, sha256: current.page.imageSha256}});
    expect(f.submit.mock.calls[0][1]).not.toHaveProperty('regenerate_of');
    expect(f.submit.mock.calls[0][1]).not.toHaveProperty('retry_of');
    await expect(f.core.manual(current)).rejects.toThrow('原请求结果待核实');
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it('keeps response failures unresolved and retries only the old UUID lookup', async () => {
    const f = fixture(), {record, current} = await seed(f);
    vi.mocked(f.api.translations).mockRejectedValueOnce(Error('offline'));
    await f.core.submit([current]);
    expect(f.submit).not.toHaveBeenCalled();
    vi.mocked(f.api.translations).mockResolvedValue({unchanged: false, etag: undefined, items: [], missing_ids: [record.requestId]});
    await f.core.manual(current);
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0][0]).not.toBe(record.requestId);
  });

  it('isolates another account and never modifies the old database', async () => {
    const owner = fixture(), {record, current} = await seed(owner), other = fixture();
    await other.core.submit([current]);
    expect(other.submit).toHaveBeenCalledOnce();
    expect(other.api.translations).not.toHaveBeenCalled();
    const database = await legacyDatabase();
    try {
      const persisted = await new Promise<LocalOperation>((resolve, reject) => {
        const get = database.transaction('operations').objectStore('operations').get(record.id);
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      expect(persisted).toEqual(record);
    } finally { database.close(); }
  });
});
