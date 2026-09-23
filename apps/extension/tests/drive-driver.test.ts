import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {SourceConnection} from '../src/comics/domain';
import type {OpenFileSourceContext} from '../src/comics/sources/contracts';

const client = vi.hoisted(() => ({
  chooseDriveFiles: vi.fn(), disconnectDrive: vi.fn(), openDriveSource: vi.fn(),
  isDriveConfigured: vi.fn(), onDriveAccessChanged: vi.fn(),
}));
vi.mock('../src/comics/sources/google-drive/index', () => client);
import {googleDriveDriver} from '../src/comics/sources/google-drive/driver';

const connection: SourceConnection = {id: 'drive:account-1', provider: 'google-drive', accountId: 'account-1', displayName: 'Alice',
  status: 'connected', generation: 1, createdAt: 1, updatedAt: 1};
const snapshot = {accountId: 'account-1', fileId: 'file-1', resourceKey: 'key-1', version: '17', size: 1000};
function context(): OpenFileSourceContext {
  return {connection, documentId: 'document', format: 'cbz',
    binding: {id: 'binding', connectionId: connection.id, providerItemId: 'file-1', locator: {...snapshot, version: '99'}, generation: 1, createdAt: 1, updatedAt: 1},
    revision: {id: 'revision', documentId: 'document', sourceSnapshot: {...snapshot}, parserVersion: 'v1', indexVersion: 1,
      generation: 1, status: 'ready', createdAt: 1}};
}
beforeEach(() => { vi.resetAllMocks(); });

describe('Google Drive file source driver', () => {
  it('maps verified selection into opaque source metadata with a real item ID distinct from its revision key', async () => {
    const chosen = {account: {id: 'account-1', displayName: 'Alice'}, files: [
      {...snapshot, name: 'Comic.cbz', mimeType: 'application/zip', format: 'cbz'},
      {fileId: 'image-1', version: '4', size: 100, name: 'Page.png', mimeType: 'image/png', format: 'image'},
    ]};
    client.chooseDriveFiles.mockResolvedValue(chosen);
    const signal = new AbortController().signal;
    const result = await googleDriveDriver.select!(connection, signal);
    expect(client.chooseDriveFiles).toHaveBeenCalledWith('account-1', signal);
    expect(result.connection).toEqual({id: 'drive:account-1', provider: 'google-drive', accountId: 'account-1', displayName: 'Alice'});
    expect(result.files[0]).toEqual({id: 'file-1', name: 'Comic.cbz', format: 'cbz', sourceKey: 'drive:["account-1","file-1","17"]', locator: snapshot, snapshot});
    expect(result.files[1]).toMatchObject({id: 'image-1', format: 'image', snapshot: {accountId: 'account-1', version: '4'}});
    chosen.files[0].version = '18';
    expect(result.files[0].snapshot.version).toBe('17');
    expect(googleDriveDriver).toMatchObject({id: 'google-drive', label: 'Google Drive', cachePages: true, cacheRanges: true});
    client.isDriveConfigured.mockReturnValue(false); expect(googleDriveDriver.isConfigured!()).toBe(false);
  });

  it('allows account-only reconnect and rejects an account mismatch before registering anything', async () => {
    client.chooseDriveFiles.mockResolvedValue({account: {id: 'account-1', displayName: 'Alice'}, files: []});
    expect((await googleDriveDriver.select!()).files).toEqual([]);
    client.chooseDriveFiles.mockResolvedValue({account: {id: 'account-2', displayName: 'Bob'}, files: []});
    await expect(googleDriveDriver.select!(connection)).rejects.toMatchObject({code: 'account-mismatch'});
  });

  it('does not start a cancelled selection or return one cancelled while the provider is running', async () => {
    const early = new AbortController(); early.abort();
    await expect(googleDriveDriver.select!(undefined, early.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(client.chooseDriveFiles).not.toHaveBeenCalled();
    const during = new AbortController();
    client.chooseDriveFiles.mockImplementation(async () => { during.abort(); return {account: {id: 'account-1'}, files: []}; });
    await expect(googleDriveDriver.select!(connection, during.signal)).rejects.toMatchObject({name: 'AbortError'});
  });

  it.each(['cbz', 'zip', 'image'] as const)('opens %s from the frozen revision instead of the mutable binding locator', async format => {
    const input = context(); input.format = format; input.signal = new AbortController().signal;
    const source = {snapshot: {identity: 'source'}, close: vi.fn()}; client.openDriveSource.mockResolvedValue(source);
    expect(await googleDriveDriver.open(input)).toBe(source);
    expect(client.openDriveSource).toHaveBeenCalledWith(snapshot, input.signal);
    const opened = client.openDriveSource.mock.calls[0][0];
    expect(Object.isFrozen(opened)).toBe(true);
    input.revision.sourceSnapshot!.version = '18'; expect(opened.version).toBe('17');
  });

  it.each(['pdf', 'mobi', 'rar', 'cbr', 'images', 'website'] as const)('refuses remote %s before requesting credentials or bytes', async format => {
    const input = context(); input.format = format;
    await expect(googleDriveDriver.open(input)).rejects.toMatchObject({code: 'unsupported-format'});
    expect(client.openDriveSource).not.toHaveBeenCalled();
  });

  it.each([
    undefined, {}, {...snapshot, fileId: '../file'}, {...snapshot, resourceKey: 'bad/key'},
    {...snapshot, version: 'latest'}, {...snapshot, size: 0}, {...snapshot, size: 1.5},
  ])('rejects incomplete or malformed frozen source metadata', async value => {
    const input = context(); input.revision.sourceSnapshot = value;
    await expect(googleDriveDriver.open(input)).rejects.toMatchObject({code: 'invalid-response'});
    expect(client.openDriveSource).not.toHaveBeenCalled();
  });

  it('rejects a frozen revision from another account or another source item', async () => {
    const foreign = context(); foreign.revision.sourceSnapshot!.accountId = 'account-2';
    await expect(googleDriveDriver.open(foreign)).rejects.toMatchObject({code: 'account-mismatch'});
    const item = context(); item.binding.providerItemId = 'other-file';
    await expect(googleDriveDriver.open(item)).rejects.toMatchObject({code: 'invalid-response'});
    expect(client.openDriveSource).not.toHaveBeenCalled();
  });

  it('maps source access events to generic connection and item identity and preserves unsubscribe', async () => {
    const unsubscribe = vi.fn(); client.onDriveAccessChanged.mockReturnValue(unsubscribe);
    const listener = vi.fn().mockResolvedValue(undefined);
    const stop = googleDriveDriver.subscribe!(listener);
    const changed = client.onDriveAccessChanged.mock.calls[0][0];
    await changed('account-1', 'file-1'); await changed('account-1');
    expect(listener.mock.calls).toEqual([[{connectionId: 'drive:account-1', itemId: 'file-1'}], [{connectionId: 'drive:account-1'}]]);
    stop(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('disconnects only a matching provider account through its client', async () => {
    await googleDriveDriver.disconnect!(connection); expect(client.disconnectDrive).toHaveBeenCalledWith('account-1');
    await expect(googleDriveDriver.disconnect!({...connection, provider: 'other'})).rejects.toMatchObject({code: 'account-mismatch'});
    expect(client.disconnectDrive).toHaveBeenCalledOnce();
  });
});
