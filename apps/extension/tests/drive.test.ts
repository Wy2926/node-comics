import {describe, expect, it, vi} from 'vitest';
import {DriveRangeSource} from '../src/comics/sources/google-drive/range-source';
import {fetchDriveAccount, fetchDriveMetadata, type DriveBinding} from '../src/comics/sources/google-drive/metadata';
import {checkDriveResponse} from '../src/comics/sources/google-drive/errors';
import {parseBridgePayload, validateBridgeSender, type PendingDriveBridge} from '../src/comics/sources/google-drive/bridge-protocol';

const binding: DriveBinding = {accountId: 'account-1', fileId: 'file-1', version: '17', size: 1000, resourceKey: 'resource-1'};
const metadata = (version = '17', extra = {}) => Response.json({id: 'file-1', name: 'book.cbz', mimeType: 'application/zip', size: '1000', version, capabilities: {canDownload: true}, ...extra});
function range(bytes = new Uint8Array([1,2,3,4]), extra: ResponseInit = {}) {
  return new Response(bytes, {status: 206, headers: {'Content-Range': 'bytes 10-13/1000', 'Content-Length': '4'}, ...extra});
}
function source(responses: Response[], options = {}) {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift(); if (!response) throw Error('Unexpected request'); return response;
  });
  return {request, source: new DriveRangeSource(binding, {token: async () => 'session-token', fetch: request, ...options})};
}
describe('Drive range safety', () => {
  it('preserves the browser fetch receiver for both metadata and range requests', async () => {
    const responses=[metadata(),range(),metadata()];
    const request=vi.fn<typeof fetch>(function(this:unknown){
      if(this!==globalThis)throw new TypeError('Illegal invocation');
      return Promise.resolve(responses.shift()!);
    });
    const drive=new DriveRangeSource(binding,{token:async()=>'session-token',fetch:request});
    expect([...await drive.readAt(10,4)]).toEqual([1,2,3,4]);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('uses exact fixed API range and validates the version on both sides', async () => {
    const {source: drive, request} = source([metadata(), range(), metadata()]);
    expect([...await drive.readAt(10,4)]).toEqual([1,2,3,4]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(String(request.mock.calls[1][0])).toBe('https://www.googleapis.com/drive/v3/files/file-1?alt=media&supportsAllDrives=true');
    const headers = request.mock.calls[1][1]?.headers as Headers;
    expect(headers.get('Range')).toBe('bytes=10-13');
    expect(headers.get('X-Goog-Drive-Resource-Keys')).toBe('file-1/resource-1');
    expect(drive.snapshot).toEqual({identity:'google-drive:account-1:file-1', version:'17', size:1000, local:false});
  });
  it('cancels an ignored Range 200 before reading its body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({cancel}), {status:200});
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const {source: drive, request} = source([metadata(), response]);
    await expect(drive.readAt(10,4)).rejects.toMatchObject({code:'range-unsupported'});
    expect(cancel).toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    [new Uint8Array(4), {'Content-Range':'bytes 11-14/1000'}],
    [new Uint8Array(4), {'Content-Range':'bytes 10-13/999'}],
    [new Uint8Array(4), {'Content-Range':'bytes 10-13/1000', 'Content-Length':'7'}],
    [new Uint8Array(3), {'Content-Range':'bytes 10-13/1000'}],
    [new Uint8Array(5), {'Content-Range':'bytes 10-13/1000'}],
  ])('rejects mismatched range or length', async (bytes, headers) => {
    const {source: drive} = source([metadata(), range(bytes, {status:206, headers})]);
    await expect(drive.readAt(10,4)).rejects.toMatchObject({code:'invalid-response'});
  });
  it('discards data and permanently stops the old snapshot on version change', async () => {
    const {source: drive, request} = source([metadata(), range(), metadata('18')]);
    await expect(drive.readAt(10,4)).rejects.toMatchObject({code:'source-changed'});
    expect(await drive.validate()).toBe('changed');
    await expect(drive.readAt(20,4)).rejects.toMatchObject({code:'source-changed'});
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('rejects invalid boundaries and budget before network I/O', async () => {
    const {source: drive, request} = source([], {maxNetworkBytes:3});
    await expect(drive.readAt(-1,1)).rejects.toBeInstanceOf(RangeError);
    await expect(drive.readAt(999,2)).rejects.toBeInstanceOf(RangeError);
    await expect(drive.readAt(0,4)).rejects.toMatchObject({code:'budget-exceeded'});
    expect(request).not.toHaveBeenCalled();
  });
  it('distinguishes expired credentials from explicit lost access and only purges the latter', async () => {
    const onAccessLost = vi.fn();
    const first = source([new Response('', {status:401})], {onAccessLost});
    await expect(first.source.readAt(10,4)).rejects.toMatchObject({code:'reconnect-required'});
    expect(onAccessLost).not.toHaveBeenCalled();
    const second = source([Response.json({error:{errors:[{reason:'appNotAuthorizedToFile'}]}}, {status:403})], {onAccessLost});
    await expect(second.source.readAt(10,4)).rejects.toMatchObject({code:'access-revoked'});
    expect(onAccessLost).toHaveBeenCalledWith(binding);
  });
  it('cancels without issuing more requests', async () => {
    const {source: drive, request} = source([]);
    const controller = new AbortController(); controller.abort();
    await expect(drive.readAt(10,4,controller.signal)).rejects.toMatchObject({name:'AbortError'});
    await drive.close();
    await expect(drive.readAt(10,4)).rejects.toMatchObject({name:'AbortError'});
    expect(request).not.toHaveBeenCalled();
  });
  it('merges simultaneous identical ranges and keeps the other consumer alive on cancellation', async () => {
    let release!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    const request=vi.fn<typeof fetch>().mockImplementationOnce(async()=>{await wait;return metadata();})
      .mockResolvedValueOnce(range()).mockResolvedValueOnce(metadata());
    const drive=new DriveRangeSource(binding,{token:async()=> 'token',fetch:request});
    const abort=new AbortController(),first=drive.readAt(10,4,abort.signal),second=drive.readAt(10,4);
    abort.abort();await expect(first).rejects.toMatchObject({name:'AbortError'});release();
    expect([...await second]).toEqual([1,2,3,4]);expect(request).toHaveBeenCalledTimes(3);expect(drive.networkBytes).toBe(4);
  });
});
describe('Drive metadata and authority', () => {
  it('takes stable account identity from about.permissionId, never a picker label', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({user:{permissionId:'stable-account',displayName:'Alice'}}));
    expect(await fetchDriveAccount('token',undefined,request)).toEqual({id:'stable-account',displayName:'Alice'});
    expect(String(request.mock.calls[0][0])).toContain('/about?fields=');
  });
  it('reads only optional display email from the verified account response', async () => {
    const request=vi.fn<typeof fetch>().mockResolvedValue(Response.json({user:{permissionId:'stable-account',displayName:'Alice',emailAddress:' reader@example.test ',accessToken:'must-not-be-copied'}}));
    expect(await fetchDriveAccount('token',undefined,request)).toEqual({id:'stable-account',displayName:'Alice',emailAddress:'reader@example.test'});
    request.mockResolvedValue(Response.json({user:{permissionId:'stable-account',emailAddress:{invalid:true}}}));
    expect(await fetchDriveAccount('token',undefined,request)).toEqual({id:'stable-account',displayName:'Google Drive'});
  });
  it('requires verified download capability and refuses PDF before range reads', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata('17', {capabilities:{canDownload:false}})).mockResolvedValueOnce(metadata('17',{name:'book.pdf',mimeType:'application/pdf'}));
    await expect(fetchDriveMetadata(binding,'token',undefined,request)).rejects.toMatchObject({code:'download-forbidden'});
    await expect(fetchDriveMetadata(binding,'token',undefined,request)).rejects.toMatchObject({code:'unsupported-format'});
  });
  it('does not treat rate limits as revoked access', async () => {
    await expect(checkDriveResponse(Response.json({error:{errors:[{reason:'userRateLimitExceeded'}]}},{status:403}))).rejects.toMatchObject({code:'unavailable'});
  });
});
describe('dedicated authorization bridge', () => {
  const nonce = 'c3c74259-6c74-4774-8f9b-c60c945dfc0c';
  const pending: PendingDriveBridge = {id:'operation', nonce, tabId:42, url:`https://trusted.example/drive-connect/index.html#state=${nonce}`, expiresAt:2000, documentId:'document'};
  const sender: chrome.runtime.MessageSender = {id:'extension', frameId:0, tab:{id:42} as chrome.tabs.Tab, url:pending.url, documentId:'document'};
  it('accepts only the exact active top-level tab document', () => {
    expect(() => validateBridgeSender(pending,sender,'extension',pending.url,1000)).not.toThrow();
  });
  it.each([
    {frameId:1}, {id:'another-extension'}, {tab:{id:99}},
    {url:`https://trusted.example/other#state=${nonce}`},
    {url:`https://evil.example/drive-connect/index.html#state=${nonce}`}, {documentId:'new-document'},
  ])('rejects wrong sender boundaries', patch => {
    expect(() => validateBridgeSender(pending,{...sender,...patch} as chrome.runtime.MessageSender,'extension',pending.url,1000)).toThrow();
  });
  it('rejects navigation, replay and expiry', () => {
    expect(() => validateBridgeSender(pending,sender,'extension','https://trusted.example/other',1000)).toThrow();
    expect(() => validateBridgeSender({...pending,consumed:true},sender,'extension',pending.url,1000)).toThrow();
    expect(() => validateBridgeSender(pending,sender,'extension',pending.url,2000)).toThrow();
  });
  it('accepts only bounded identifiers and drops picker download URLs and claimed account IDs', () => {
    const result = parseBridgePayload({nonce,accessToken:'private-session-token',expiresIn:3600,accountId:'untrusted',files:[{fileId:'file-1',downloadUrl:'https://evil.example/private'},{fileId:'file-1'}]},pending);
    expect(result.files).toEqual([{fileId:'file-1',resourceKey:undefined}]);
    expect(result).not.toHaveProperty('accountId');
    expect(() => parseBridgePayload({...result,nonce:'other'},pending)).toThrow();
    expect(() => parseBridgePayload({...result,files:[{fileId:'../../other'}]},pending)).toThrow();
    expect(() => parseBridgePayload({...result,files:Array.from({length:101},()=>({fileId:'file'}))},pending)).toThrow();
  });
});
