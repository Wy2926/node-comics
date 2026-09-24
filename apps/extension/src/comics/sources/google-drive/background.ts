import {driveBridgeUrl} from './config';
import {DriveError} from './errors';
import {fetchDriveAccount, fetchDriveMetadata, validDriveIdentifier, type DriveAccount, type DriveFileMetadata} from './metadata';
import {parseBridgePayload, validateBridgeSender, type PendingDriveBridge} from './bridge-protocol';

const pendingKey = (tabId: number) => `nc-drive-pending:${tabId}`;
const resultKey = (id: string) => `nc-drive-result:${id}`;
const tokenKey = (id: string) => `nc-drive-token:${id}`;
const connectionKey = (id: string) => `nc-drive-connection:${id}`;
interface DriveConnection { account: DriveAccount; generation: string; }
interface DriveToken extends DriveConnection { accessToken: string; expiresAt: number; }
const validConnection = (key: string, value: DriveConnection | undefined): value is DriveConnection =>
  !!value && validDriveIdentifier(value.account?.id) && key === connectionKey(value.account.id) && typeof value.generation === 'string' && !!value.generation;
function extensionSender(sender: chrome.runtime.MessageSender) {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}
function errorResult(error: unknown) {
  return {ok: false, code: error instanceof DriveError ? error.code : 'unavailable',
    error: error instanceof DriveError ? error.message : 'Google Drive 连接未完成，请重新尝试。'};
}
async function read<T>(key: string): Promise<T | undefined> { return (await chrome.storage.session.get(key))[key] as T | undefined; }
async function failPending(pending: PendingDriveBridge, error: DriveError) {
  await chrome.storage.session.remove(pendingKey(pending.tabId));
  await chrome.storage.session.set({[resultKey(pending.id)]: {...errorResult(error), expiresAt: pending.expiresAt}});
}
async function pendingSender(sender: chrome.runtime.MessageSender) {
  if (sender.tab?.id === undefined) throw new DriveError('invalid-bridge', '授权来源无效。');
  const pending = await read<PendingDriveBridge>(pendingKey(sender.tab.id));
  if (!pending) throw new DriveError('invalid-bridge', '授权已结束。');
  const tab = await chrome.tabs.get(pending.tabId);
  validateBridgeSender(pending, sender, chrome.runtime.id, tab.url);
  return pending;
}
export function registerDriveBackground() {
  if (!driveBridgeUrl()) return;
  const consuming = new Set<string>();
  const initializing = new Set<string>();
  const tabEpochs = new Map<number, number>();
  const tabEpoch = (tabId: number) => {
    const epoch = tabEpochs.get(tabId) ?? 0;
    tabEpochs.set(tabId, epoch); return epoch;
  };
  const invalidateTab = (tabId: number) => { if (tabEpochs.has(tabId)) tabEpochs.set(tabId, tabEpochs.get(tabId)! + 1); };
  let authorizationEpoch = 0;
  let disconnecting = 0;
  // Serialize verified connection writes and explicit disconnects. Only account
  // metadata persists across restarts; OAuth credentials remain in trusted session storage.
  let connectionWrites: Promise<unknown> = Promise.resolve();
  const writeConnection = <T>(action: () => Promise<T>): Promise<T> => {
    const result = connectionWrites.then(action);
    connectionWrites = result.catch(() => {});
    return result;
  };
  void chrome.storage.session.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
  chrome.tabs.onRemoved.addListener(tabId => {
    invalidateTab(tabId);
    void read<PendingDriveBridge>(pendingKey(tabId)).then(pending => pending && failPending(pending, new DriveError('cancelled', 'Google Drive 连接已取消。'))).finally(() => tabEpochs.delete(tabId)).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === 'loading') invalidateTab(tabId);
    void (async () => {
      const pending = await read<PendingDriveBridge>(pendingKey(tabId));
      if (!pending) return;
      if (pending.oauth?.phase === 'away' && pending.expiresAt > Date.now()) {
        // Google pages do not need host permissions. Their URLs may be hidden
        // from tabs events; only our exact callback gets the bridge again.
        if (!change.url && !tab.url) return;
        const currentUrl = new URL(change.url ?? tab.url ?? 'about:blank');
        const callback = new URL(pending.url);
        const onCallback = currentUrl.origin === callback.origin && currentUrl.pathname === callback.pathname;
        const onGoogle = currentUrl.protocol === 'https:' && !currentUrl.port &&
          ['accounts.google.com', 'docs.google.com', 'drive.google.com'].includes(currentUrl.hostname);
        if (!onCallback && !onGoogle) {
          await failPending(pending, new DriveError('invalid-bridge', '授权页面已过期或离开。')); return;
        }
        // The local callback script removes the OAuth fragment before this document
        // receives the bridge. Never persist or log the navigation URL / credentials.
        if (change.status === 'complete' && tab.url === pending.url) {
          const capturedEpoch = authorizationEpoch, capturedTabEpoch = tabEpoch(tabId);
          pending.oauth.phase = 'returned';
          await chrome.storage.session.set({[pendingKey(tabId)]: pending});
          if (disconnecting || authorizationEpoch !== capturedEpoch || tabEpochs.get(tabId) !== capturedTabEpoch) {
            await failPending(pending, new DriveError('invalid-bridge', '授权页面已离开。')); return;
          }
          await chrome.scripting.executeScript({target: {tabId, frameIds: [0]}, files: ['content-scripts/drive-bridge.js']});
        }
        return;
      }
      if (pending.expiresAt < Date.now() || (change.url && change.url !== pending.url) || ((pending.initialized || initializing.has(pending.id)) && change.status === 'loading')) {
        await failPending(pending, new DriveError('invalid-bridge', '授权页面已过期或离开。')); return;
      }
      if (pending.consumed) return;
      if (change.status === 'complete' && tab.url === pending.url) {
        await chrome.scripting.executeScript({target: {tabId, frameIds: [0]}, files: ['content-scripts/drive-bridge.js']});
      }
    })().catch(() => {});
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['NC_DRIVE_BRIDGE_INIT', 'NC_DRIVE_BRIDGE_RESULT', 'NC_DRIVE_OAUTH_START', 'NC_DRIVE_CONNECT', 'NC_DRIVE_STATUS', 'NC_DRIVE_TOKEN', 'NC_DRIVE_DISCONNECT', 'NC_DRIVE_ACCOUNTS'].includes(message?.type)) return;
    void (async () => {
      if (message.type === 'NC_DRIVE_OAUTH_START') {
        const capturedEpoch = authorizationEpoch;
        const capturedTabEpoch = sender.tab?.id === undefined ? undefined : tabEpoch(sender.tab.id);
        const assertActive = () => {
          if (disconnecting || capturedEpoch !== authorizationEpoch || capturedTabEpoch === undefined ||
              tabEpochs.get(sender.tab!.id!) !== capturedTabEpoch)
            throw new DriveError('invalid-bridge', '授权页面已失效。');
        };
        const pending = await pendingSender(sender);
        assertActive();
        if (!pending.initialized || message.nonce !== pending.nonce || typeof message.clientId !== 'string' ||
            !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(message.clientId) || initializing.has(pending.id))
          throw new DriveError('invalid-bridge', '授权返回无效。');
        initializing.add(pending.id);
        try {
          const state = crypto.randomUUID() + crypto.randomUUID();
          const callback = new URL(pending.url); callback.hash = '';
          const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          authorize.search = new URLSearchParams({client_id: message.clientId, redirect_uri: callback.href,
            response_type: 'token', scope: 'https://www.googleapis.com/auth/drive.file',
            include_granted_scopes: 'false', prompt: 'consent select_account', trigger_onepick: 'true',
            allow_multiple: 'true', state}).toString();
          pending.oauth = {state, phase: 'away'};
          delete pending.documentId; delete pending.initialized;
          await chrome.storage.session.set({[pendingKey(pending.tabId)]: pending});
          assertActive();
          return {ok: true, state, url: authorize.href, expiresAt: pending.expiresAt};
        } catch (error) {
          await failPending(pending, new DriveError('invalid-bridge', '授权页面已失效。'));
          throw error;
        } finally { initializing.delete(pending.id); }
      }
      if (message.type === 'NC_DRIVE_BRIDGE_INIT') {
        const capturedTabEpoch = sender.tab?.id === undefined ? undefined : tabEpoch(sender.tab.id);
        const capturedEpoch = authorizationEpoch;
        const assertActive = () => {
          if (disconnecting || capturedTabEpoch === undefined || tabEpochs.get(sender.tab!.id!) !== capturedTabEpoch || capturedEpoch !== authorizationEpoch)
            throw new DriveError('invalid-bridge', '授权页面已失效。');
        };
        const pending = await pendingSender(sender);
        assertActive();
        if (pending.initialized || initializing.has(pending.id)) throw new DriveError('invalid-bridge', '授权页面已初始化。');
        if (pending.oauth?.phase === 'away') throw new DriveError('invalid-bridge', '授权页面已失效。');
        initializing.add(pending.id);
        try {
          await connectionWrites;
          const [connections, session] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]);
          const expectedAccount = (id: string) => !pending.expectedAccountId || id === pending.expectedAccountId;
          const remembered = Object.entries(connections).some(([key, value]) =>
            validConnection(key, value as DriveConnection) && expectedAccount((value as DriveConnection).account.id));
          const connected = Object.entries(session).some(([key, value]) => {
            const token = value as DriveToken | undefined;
            return validDriveIdentifier(token?.account?.id) && key === tokenKey(token.account.id) &&
              expectedAccount(token.account.id) && !!token.generation && typeof token.accessToken === 'string' && token.expiresAt > Date.now();
          });
          const autoRedirect = !pending.oauth && (remembered || connected);
          const current = await pendingSender(sender);
          assertActive();
          if (current.id !== pending.id || current.initialized) throw new DriveError('invalid-bridge', '授权页面已失效。');
          pending.documentId = sender.documentId; pending.initialized = true;
          await chrome.storage.session.set({[pendingKey(pending.tabId)]: pending});
          await pendingSender(sender);
          assertActive();
          // The page receives a navigation hint, never a cached access token.
          return {ok: true, nonce: pending.nonce, expiresAt: pending.expiresAt, oauthRedirect: true, autoRedirect};
        } catch (error) {
          await failPending(pending, error instanceof DriveError ? error : new DriveError('unavailable', 'Google Drive 连接未完成，请重新尝试。'));
          throw error;
        } finally { initializing.delete(pending.id); }
      }
      if (message.type === 'NC_DRIVE_BRIDGE_RESULT') {
        const capturedTabEpoch = sender.tab?.id === undefined ? undefined : tabEpoch(sender.tab.id);
        const capturedEpoch = authorizationEpoch;
        const assertActive = () => {
          if (disconnecting || capturedTabEpoch === undefined || tabEpochs.get(sender.tab!.id!) !== capturedTabEpoch || capturedEpoch !== authorizationEpoch)
            throw new DriveError('invalid-bridge', '授权页面已离开。');
        };
        const pending = await pendingSender(sender);
        assertActive();
        if (!pending.initialized) throw new DriveError('invalid-bridge', '授权页面尚未初始化。');
        const payload = parseBridgePayload(message.payload, pending);
        if (consuming.has(pending.id)) throw new DriveError('invalid-bridge', '授权返回已消费。');
        consuming.add(pending.id);
        const receivedAt = Date.now();
        // Consume before doing network I/O. A replay cannot issue a second import or replace the token.
        pending.consumed = true;
        try {
          await chrome.storage.session.set({[pendingKey(pending.tabId)]: pending});
          assertActive();
          const signal = AbortSignal.timeout(30_000);
          const account = await fetchDriveAccount(payload.accessToken, signal);
          if (pending.expectedAccountId && account.id !== pending.expectedAccountId) throw new DriveError('account-mismatch', '请选择原来连接的 Google Drive 账户。');
          const existing = await read<DriveToken>(tokenKey(account.id));
          // A returned access token cannot renew itself by claiming a fresh relative lifetime.
          const sameToken = existing?.accessToken === payload.accessToken ? existing : undefined;
          const expiresAt = sameToken ? sameToken.expiresAt : receivedAt + payload.expiresIn * 1000 - 30_000;
          if (expiresAt <= Date.now()) throw new DriveError('reconnect-required', 'Google Drive 授权已过期，请重新连接。');
          const files: DriveFileMetadata[] = [];
          for (const reference of payload.files) files.push(await fetchDriveMetadata(reference, payload.accessToken, signal));
          // Tab navigation/disconnect while verifying invalidates this generation.
          const current = await read<PendingDriveBridge>(pendingKey(pending.tabId));
          const tab = await chrome.tabs.get(pending.tabId);
          if (current?.id !== pending.id || tab.url !== pending.url || Date.now() >= pending.expiresAt)
            throw new DriveError('invalid-bridge', '授权页面已离开。');
          if (sameToken) {
            const currentToken = await read<DriveToken>(tokenKey(account.id));
            if (currentToken?.generation !== sameToken.generation || currentToken.accessToken !== payload.accessToken || currentToken.expiresAt <= Date.now())
              throw new DriveError('reconnect-required', 'Google Drive 连接已变化或过期，请重新连接。');
          }
          assertActive();
          if (expiresAt <= Date.now()) throw new DriveError('reconnect-required', 'Google Drive 连接已变化或过期，请重新连接。');
          await writeConnection(async () => {
            assertActive();
            if (expiresAt <= Date.now() || pending.expiresAt <= Date.now()) throw new DriveError('reconnect-required', 'Google Drive 授权已过期，请重新连接。');
            const key = connectionKey(account.id);
            const previousConnection = (await chrome.storage.local.get(key))[key] as DriveConnection | undefined;
            const previousToken = await read<DriveToken>(tokenKey(account.id));
            assertActive();
            if (previousToken?.generation !== existing?.generation || previousToken?.accessToken !== existing?.accessToken)
              throw new DriveError('reconnect-required', 'Google Drive 连接已更新，请重新连接。');
            const token: DriveToken = {accessToken: payload.accessToken, expiresAt, account, generation: sameToken?.generation ?? crypto.randomUUID()};
            try {
              await chrome.storage.local.set({[key]: {account, generation: token.generation} satisfies DriveConnection});
              assertActive();
              await chrome.storage.session.set({[tokenKey(account.id)]: token,
                [resultKey(pending.id)]: {ok: true, account, files, expiresAt: pending.expiresAt}});
              assertActive();
              await chrome.storage.session.remove(pendingKey(pending.tabId));
              assertActive();
            } catch (error) {
              // Roll back before a queued disconnect can finish, including writes
              // that were already in flight when navigation invalidated the bridge.
              if (previousConnection && capturedEpoch === authorizationEpoch) await chrome.storage.local.set({[key]: previousConnection});
              else await chrome.storage.local.remove(key);
              if (previousToken && capturedEpoch === authorizationEpoch) await chrome.storage.session.set({[tokenKey(account.id)]: previousToken});
              else await chrome.storage.session.remove(tokenKey(account.id));
              throw error;
            }
          });
          // Finish the bridge before closing, so onRemoved cannot cancel the saved selection.
          if (files.length) await chrome.tabs.remove(pending.tabId).catch(() => {});
          return {ok: true};
        } catch (error) {
          await chrome.storage.session.remove(pendingKey(pending.tabId));
          await chrome.storage.session.set({[resultKey(pending.id)]: {...errorResult(error), expiresAt: pending.expiresAt}});
          return errorResult(error);
        } finally {
          consuming.delete(pending.id);
        }
      }
      if (!extensionSender(sender)) throw new DriveError('invalid-bridge', '请通过插件页面连接 Google Drive。');
      if (message.type === 'NC_DRIVE_ACCOUNTS') {
        const epoch=authorizationEpoch;
        await connectionWrites;
        const [local,session]=await Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null)]);
        if(disconnecting||epoch!==authorizationEpoch)throw new DriveError('reconnect-required','Google Drive 连接已变化，请重新连接。');
        // Return a strict public projection, never token records, grants or browser profile accounts.
        const accounts=new Map<string,{account:DriveAccount;status:'connected'|'reauth-required'}>();
        const display=(value:DriveAccount):DriveAccount=>({id:value.id,displayName:typeof value.displayName==='string'?value.displayName.slice(0,256):'Google Drive',
          ...(typeof value.emailAddress==='string'&&value.emailAddress?{emailAddress:value.emailAddress.slice(0,320)}:{})});
        for(const [key,value] of Object.entries(local)) {
          const connection=value as DriveConnection|undefined;
          if(!validConnection(key,connection))continue;
          accounts.set(connection.account.id,{account:display(connection.account),status:'reauth-required'});
        }
        for(const [key,value] of Object.entries(session)) {
          const token=value as DriveToken|undefined;
          if(!key.startsWith('nc-drive-token:')||!validDriveIdentifier(token?.account?.id)||key!==tokenKey(token.account.id)||!token.generation)continue;
          const connected=typeof token.accessToken==='string'&&Number.isFinite(token.expiresAt)&&token.expiresAt>Date.now();
          accounts.set(token.account.id,{account:display(token.account),status:connected?'connected':'reauth-required'});
        }
        return {ok:true,accounts:[...accounts.values()]};
      }
      if (message.type === 'NC_DRIVE_CONNECT') {
        const base = driveBridgeUrl();
        if (!base) throw new DriveError('not-configured', '尚未配置 Google Drive 授权页面。');
        if (message.expectedAccountId !== undefined && !validDriveIdentifier(message.expectedAccountId)) throw new DriveError('invalid-bridge', '无效的账户标识。');
        const capturedEpoch = authorizationEpoch;
        const assertActive = () => {
          if (disconnecting || capturedEpoch !== authorizationEpoch) throw new DriveError('cancelled', 'Google Drive 连接已取消。');
        };
        assertActive();
        const id = crypto.randomUUID(), nonce = crypto.randomUUID() + crypto.randomUUID();
        // Keep authorization outside the reader's tab strip. The popup's tab still
        // uses the same document-bound bridge and cancellation handling.
        const popup = await chrome.windows.create({url: 'about:blank', type: 'popup', width: 1000, height: 800, focused: true});
        const tab = popup?.tabs?.[0];
        if (tab?.id === undefined) {
          if (popup?.id !== undefined) await chrome.windows.remove(popup.id).catch(() => {});
          throw new DriveError('unavailable', '无法打开授权页面。');
        }
        try {
          assertActive();
          const pending: PendingDriveBridge = {id, nonce, tabId: tab.id, url: `${base}#state=${nonce}`, expiresAt: Date.now() + 10 * 60_000, expectedAccountId: message.expectedAccountId};
          await chrome.storage.session.set({[pendingKey(tab.id)]: pending});
          assertActive();
          await chrome.tabs.update(tab.id, {url: pending.url});
          assertActive();
          return {ok: true, id, tabId: tab.id};
        } catch (error) {
          await chrome.storage.session.remove(pendingKey(tab.id));
          await chrome.tabs.remove(tab.id).catch(() => {});
          throw error;
        }
      }
      if (message.type === 'NC_DRIVE_STATUS') {
        if (typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id)) throw new DriveError('invalid-bridge', '无效的连接标识。');
        if (consuming.has(message.id)) return {ok: true, pending: true};
        const key = resultKey(message.id);
        const result = await read<{expiresAt: number}>(key);
        if (consuming.has(message.id)) return {ok: true, pending: true};
        if (!result) return {ok: true, pending: true};
        await chrome.storage.session.remove(key);
        return result.expiresAt <= Date.now() ? errorResult(new DriveError('cancelled', '授权已过期。')) : result;
      }
      if (message.type === 'NC_DRIVE_TOKEN') {
        if (!validDriveIdentifier(message.accountId)) throw new DriveError('invalid-bridge', '无效的账户标识。');
        const capturedEpoch = authorizationEpoch;
        if (disconnecting) throw new DriveError('reconnect-required', 'Google Drive 正在断开连接。');
        const key = tokenKey(message.accountId);
        const token = await read<DriveToken>(key);
        if (capturedEpoch !== authorizationEpoch) throw new DriveError('reconnect-required', 'Google Drive 连接已断开，请重新连接。');
        if (!token || token.expiresAt <= Date.now()) {
          if (token) await chrome.storage.session.remove(key);
          throw new DriveError('reconnect-required', '请重新连接 Google Drive，已缓存页面仍可阅读。');
        }
        if (message.generation && message.generation !== token.generation) throw new DriveError('reconnect-required', 'Google Drive 连接已更新，请重新打开此文档。');
        return {ok: true, ...token};
      }
      if (message.type === 'NC_DRIVE_DISCONNECT') {
        if (!validDriveIdentifier(message.accountId)) throw new DriveError('invalid-bridge', '无效的账户标识。');
        authorizationEpoch++; disconnecting++;
        try {
        await writeConnection(async () => {
          await chrome.storage.local.remove(connectionKey(message.accountId));
          await chrome.storage.session.remove(tokenKey(message.accountId));
        });
        const session = await chrome.storage.session.get(null);
        for (const [key, value] of Object.entries(session)) {
          if (key.startsWith('nc-drive-pending:')) {
            const pending = value as PendingDriveBridge;
            await failPending(pending, new DriveError('cancelled', '连接已断开，正在进行的授权已取消。'));
          }
        }
        // Includes other extension tabs so their in-flight reads can be cancelled before cache cleanup.
        void chrome.runtime.sendMessage({type: 'NC_DRIVE_DISCONNECTED', accountId: message.accountId}).catch(() => {});
        return {ok: true};
        } finally { authorizationEpoch++; disconnecting--; }
      }
      return undefined;
    })().then(respond).catch(error => respond(errorResult(error)));
    return true;
  });
}
