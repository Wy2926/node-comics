import {afterEach, describe, expect, it, vi} from 'vitest';

async function client() {
  vi.resetModules();
  const listeners: ((message: Record<string, unknown>, sender: {id: string}) => void)[] = [];
  const sendMessage = vi.fn(async () => ({ok: true, accessToken: 'fake-token', generation: 'generation-1'}));
  vi.stubGlobal('chrome', {runtime: {id: 'extension', sendMessage, onMessage: {addListener: (listener: typeof listeners[number]) => listeners.push(listener)}}});
  return {api: await import('../src/comics/sources/google-drive/index'), sendMessage,
    emit: (accountId: string, senderId = 'extension') => { for (const listener of listeners) listener({type: 'NC_DRIVE_DISCONNECTED', accountId}, {id: senderId}); }};
}
const binding = {accountId: 'account-1', fileId: 'file-1', version: '17', size: 1000};
const metadata = (id = 'file-1') => Response.json({id, name: 'Comic.cbz', mimeType: 'application/zip', size: '1000', version: '17', capabilities: {canDownload: true}});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Drive access notifications without cache ownership', () => {
  it('notifies multiple subscribers and removes only the unsubscribed listener', async () => {
    const {api} = await client(); const first = vi.fn().mockResolvedValue(undefined), second = vi.fn().mockResolvedValue(undefined);
    const stop = api.onDriveAccessChanged(first); api.onDriveAccessChanged(second);
    await api.disconnectDrive('account-1'); expect(first).toHaveBeenCalledWith('account-1', undefined); expect(second).toHaveBeenCalledOnce();
    stop(); await api.disconnectDrive('account-1'); expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2);
  });

  it('closes active sources on a verified cross-tab disconnect but ignores another extension', async () => {
    const {api, emit} = await client(); const changed = vi.fn().mockResolvedValue(undefined); api.onDriveAccessChanged(changed);
    const request = vi.fn<typeof fetch>().mockResolvedValue(metadata());
    const source = await api.openDriveSource(binding, undefined, {fetch: request}); const close = vi.spyOn(source, 'close');
    emit('account-1', 'other-extension'); await Promise.resolve(); expect(close).not.toHaveBeenCalled();
    emit('account-1'); await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('account-1', undefined));
    expect(close).toHaveBeenCalledOnce(); await expect(source.readAt(0, 1)).rejects.toMatchObject({name: 'AbortError'});
  });

  it('emits file-specific lost access without notifying a transient expired-token error', async () => {
    const {api} = await client(); const changed = vi.fn().mockResolvedValue(undefined); api.onDriveAccessChanged(changed);
    const denied = vi.fn<typeof fetch>().mockResolvedValue(Response.json({error: {errors: [{reason: 'appNotAuthorizedToFile'}]}}, {status: 403}));
    await expect(api.openDriveSource(binding, undefined, {fetch: denied})).rejects.toMatchObject({code: 'access-revoked'});
    expect(changed).toHaveBeenCalledWith('account-1', 'file-1'); changed.mockClear();
    const expired = vi.fn<typeof fetch>().mockResolvedValue(new Response('', {status: 401}));
    await expect(api.openDriveSource(binding, undefined, {fetch: expired})).rejects.toMatchObject({code: 'reconnect-required'});
    expect(changed).not.toHaveBeenCalled();
  });

  it('cancels before starting a connection or requesting source credentials', async () => {
    const {api, sendMessage} = await client(); const abort = new AbortController(); abort.abort();
    await expect(api.chooseDriveFiles(undefined, abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    await expect(api.openDriveSource(binding, abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
