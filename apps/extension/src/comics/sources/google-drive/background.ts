import {driveBridgeUrl} from './config';
import {DriveError} from './errors';
import {fetchDriveAccount, fetchDriveMetadata, validDriveIdentifier, type DriveAccount, type DriveFileMetadata} from './metadata';
import {parseBridgePayload, validateBridgeSender, type PendingDriveBridge} from './bridge-protocol';
import {chromeDriveAvailable, requestChromeDriveToken} from './chrome-auth';

const pendingKey = (tabId: number) => `nc-drive-pending:${tabId}`;
const resultKey = (id: string) => `nc-drive-result:${id}`;
const tokenKey = (id: string) => `nc-drive-token:${id}`;
const chromeConnectionKey = (id: string) => `nc-drive-chrome-connection:${id}`;
interface ChromeConnection { account: DriveAccount; generation: string; }
interface DriveToken { accessToken: string; expiresAt: number; account: DriveAccount; generation: string; provider?: 'chrome'; }
async function reusableToken(accountId?: string): Promise<DriveToken | undefined> {
  const session = accountId ? {[tokenKey(accountId)]: await read<DriveToken>(tokenKey(accountId))} : await chrome.storage.session.get(null);
  return Object.entries(session).filter(([key]) => key.startsWith('nc-drive-token:')).map(([, value]) => value as DriveToken | undefined)
    .filter((token): token is DriveToken => !!token && token.expiresAt > Date.now() + 30_000 && typeof token.accessToken === 'string' && !!token.generation && validDriveIdentifier(token.account?.id))
    .sort((a, b) => b.expiresAt - a.expiresAt)[0];
}
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
  let disconnecting = 0, nativeEpoch = 0, replacingNative = 0;
  const replacementVersions = new Map<string, number>();
  let nativeWrites: Promise<unknown> = Promise.resolve();
  const writeNative = <T>(action: () => Promise<T>): Promise<T> => {
    const result = nativeWrites.then(action);
    nativeWrites = result.catch(() => {});
    return result;
  };
  const nativeRequests = new Map<string, Promise<DriveToken>>();
  const readChromeConnection = async (id: string): Promise<ChromeConnection | undefined> => {
    const value = (await chrome.storage.local.get(chromeConnectionKey(id)))[chromeConnectionKey(id)] as ChromeConnection | undefined;
    return value?.account?.id === id && typeof value.generation === 'string' ? value : undefined;
  };
  const chromeToken = (accountId: string | undefined, interactive: boolean): Promise<DriveToken> => {
    const requestKey = `${authorizationEpoch}:${nativeEpoch}:${interactive}:${accountId ?? ''}`;
    const running = nativeRequests.get(requestKey);
    if (running) return running;
    const request = (async () => {
      const capturedEpoch = authorizationEpoch;
      const capturedNativeEpoch = nativeEpoch;
      const assertActive = () => {
        if (disconnecting || replacingNative || capturedEpoch !== authorizationEpoch || capturedNativeEpoch !== nativeEpoch)
          throw new DriveError('reconnect-required', 'Google Drive 连接已变化，请重新连接。');
      };
      assertActive();
      const previous = accountId ? await readChromeConnection(accountId) : undefined;
      // Persist only the user's connection choice, never an OAuth credential. A disconnect
      // must remain effective across browser restarts even if Chrome retains its grant.
      if (!interactive && !previous) throw new DriveError('reconnect-required', '请先连接 Google Drive。');
      const credential = await requestChromeDriveToken(interactive, accountId);
      assertActive();
      return writeNative(async () => {
      assertActive();
      const current = await readChromeConnection(credential.account.id);
      assertActive();
      if (!interactive && current?.generation !== previous?.generation)
        throw new DriveError('reconnect-required', 'Google Drive 连接已变化，请重新打开文档。');
      const connection: ChromeConnection = {account: credential.account, generation: current?.generation ?? crypto.randomUUID()};
      const token: DriveToken = {...credential, generation: connection.generation, provider: 'chrome',
        // This is a short lease for the Picker bridge, not Google's token expiry.
        // Every reading request goes back to Chrome's expiry-aware token cache.
        expiresAt: Date.now() + 5 * 60_000};
      try {
        if (!current) await chrome.storage.local.set({[chromeConnectionKey(credential.account.id)]: connection});
        assertActive();
        await chrome.storage.session.set({[tokenKey(credential.account.id)]: token});
        assertActive();
        return token;
      } catch (error) {
        const stored = await read<DriveToken>(tokenKey(credential.account.id));
        if (stored?.provider === 'chrome' && stored.generation === token.generation && stored.accessToken === token.accessToken)
          await chrome.storage.session.remove(tokenKey(credential.account.id));
        if (!current && (await readChromeConnection(credential.account.id))?.generation === connection.generation)
          await chrome.storage.local.remove(chromeConnectionKey(credential.account.id));
        throw error;
      }
      });
    })();
    nativeRequests.set(requestKey, request);
    void request.finally(() => { if (nativeRequests.get(requestKey) === request) nativeRequests.delete(requestKey); }).catch(() => {});
    return request;
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
    if (!['NC_DRIVE_BRIDGE_INIT', 'NC_DRIVE_BRIDGE_RESULT', 'NC_DRIVE_CONNECT', 'NC_DRIVE_STATUS', 'NC_DRIVE_TOKEN', 'NC_DRIVE_DISCONNECT', 'NC_DRIVE_ACCOUNTS'].includes(message?.type)) return;
    void (async () => {
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
        initializing.add(pending.id);
        try {
          const token = await reusableToken(pending.expectedAccountId);
          const current = await pendingSender(sender);
          assertActive();
          if (current.id !== pending.id || current.initialized) throw new DriveError('invalid-bridge', '授权页面已失效。');
          pending.documentId = sender.documentId; pending.initialized = true;
          if (token) pending.reusedToken = {accountId: token.account.id, generation: token.generation, expiresAt: token.expiresAt, accessToken: token.accessToken};
          await chrome.storage.session.set({[pendingKey(pending.tabId)]: pending});
          await pendingSender(sender);
          const latest = token && await read<DriveToken>(tokenKey(token.account.id));
          assertActive();
          const reusable = token && latest?.accessToken === token.accessToken && latest.generation === token.generation &&
            (token.provider === 'chrome' ? latest.expiresAt >= token.expiresAt : latest.expiresAt === token.expiresAt) && token.expiresAt > Date.now() + 30_000;
          // Credentials stay in trusted session storage and this exact document's one-use bridge.
          return {ok: true, nonce: pending.nonce, expiresAt: pending.expiresAt, ...(token?.provider === 'chrome' ? {authMode: 'chrome'} : {}),
            ...(reusable ? {session: {accessToken: token.accessToken, expiresAt: token.expiresAt, displayName: token.account.displayName}} : {})};
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
        let committedToken: DriveToken | undefined, keptExistingToken = false;
        let replacedConnection: ChromeConnection | undefined, replacementEpoch: number | undefined, replacementVersion: number | undefined;
        try {
          await chrome.storage.session.set({[pendingKey(pending.tabId)]: pending});
          assertActive();
          const signal = AbortSignal.timeout(30_000);
          const account = await fetchDriveAccount(payload.accessToken, signal);
          if (pending.expectedAccountId && account.id !== pending.expectedAccountId) throw new DriveError('account-mismatch', '请选择原来连接的 Google Drive 账户。');
          const reused = pending.reusedToken?.accessToken === payload.accessToken ? pending.reusedToken : undefined;
          const existing = await read<DriveToken>(tokenKey(account.id));
          if (reused && (reused.accountId !== account.id || existing?.generation !== reused.generation || existing.accessToken !== payload.accessToken || existing.expiresAt <= Date.now()))
            throw new DriveError('reconnect-required', 'Google Drive 连接已变化或过期，请重新连接。');
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
          const token: DriveToken = {accessToken: payload.accessToken, expiresAt, account, generation: sameToken?.generation ?? crypto.randomUUID(),
            ...(sameToken?.provider === 'chrome' ? {provider: 'chrome' as const} : {})};
          if (chromeDriveAvailable() && token.provider !== 'chrome') {
            // Explicitly choosing a web account must not silently switch it back on restart.
            replacingNative++; replacementEpoch = ++nativeEpoch;
            replacementVersion = (replacementVersions.get(account.id) ?? 0) + 1;
            replacementVersions.set(account.id, replacementVersion);
            await nativeWrites;
            assertActive();
            replacedConnection = await readChromeConnection(account.id);
            await chrome.storage.local.remove(chromeConnectionKey(account.id));
            assertActive();
          }
          committedToken = token; keptExistingToken = !!sameToken;
          await chrome.storage.session.set({[tokenKey(account.id)]: token,
            [resultKey(pending.id)]: {ok: true, account, files, expiresAt: pending.expiresAt}});
          assertActive();
          await chrome.storage.session.remove(pendingKey(pending.tabId));
          assertActive();
          return {ok: true};
        } catch (error) {
          // A storage write already in flight when the tab is cancelled must not restore credentials.
          if (committedToken && (!keptExistingToken || capturedEpoch !== authorizationEpoch)) {
            const stored = await read<DriveToken>(tokenKey(committedToken.account.id));
            if (stored?.generation === committedToken.generation && stored.accessToken === committedToken.accessToken)
              await chrome.storage.session.remove(tokenKey(committedToken.account.id));
          }
          const restore = replacedConnection;
          if (restore) await writeNative(async () => {
            if (capturedEpoch !== authorizationEpoch || replacementVersion !== replacementVersions.get(restore.account.id)) return;
            await chrome.storage.local.set({[chromeConnectionKey(restore.account.id)]: restore});
            if (capturedEpoch !== authorizationEpoch && (await readChromeConnection(restore.account.id))?.generation === restore.generation)
              await chrome.storage.local.remove(chromeConnectionKey(restore.account.id));
          });
          await chrome.storage.session.remove(pendingKey(pending.tabId));
          await chrome.storage.session.set({[resultKey(pending.id)]: {...errorResult(error), expiresAt: pending.expiresAt}});
          return errorResult(error);
        } finally {
          if (replacementEpoch !== undefined) { replacingNative--; nativeEpoch++; }
          consuming.delete(pending.id);
        }
      }
      if (!extensionSender(sender)) throw new DriveError('invalid-bridge', '请通过插件页面连接 Google Drive。');
      if (message.type === 'NC_DRIVE_ACCOUNTS') {
        const epoch=authorizationEpoch;
        await nativeWrites;
        const [local,session]=await Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null)]);
        if(disconnecting||replacingNative||epoch!==authorizationEpoch)throw new DriveError('reconnect-required','Google Drive 连接已变化，请重新连接。');
        // Return a strict public projection, never token records, grants or browser profile accounts.
        const accounts=new Map<string,{account:DriveAccount;status:'connected'|'reauth-required'}>();
        const display=(value:DriveAccount):DriveAccount=>({id:value.id,displayName:typeof value.displayName==='string'?value.displayName.slice(0,256):'Google Drive',
          ...(typeof value.emailAddress==='string'&&value.emailAddress?{emailAddress:value.emailAddress.slice(0,320)}:{})});
        for(const [key,value] of Object.entries(local)) {
          const connection=value as ChromeConnection|undefined;
          if(!key.startsWith('nc-drive-chrome-connection:')||!validDriveIdentifier(connection?.account?.id)||key!==chromeConnectionKey(connection.account.id)||!connection.generation)continue;
          accounts.set(connection.account.id,{account:display(connection.account),status:chromeDriveAvailable()?'connected':'reauth-required'});
        }
        for(const [key,value] of Object.entries(session)) {
          const token=value as DriveToken|undefined;
          if(!key.startsWith('nc-drive-token:')||!validDriveIdentifier(token?.account?.id)||key!==tokenKey(token.account.id)||!token.generation)continue;
          if(token.provider==='chrome'&&!accounts.has(token.account.id))continue;
          const connected=token.provider==='chrome'&&chromeDriveAvailable()||typeof token.accessToken==='string'&&Number.isFinite(token.expiresAt)&&token.expiresAt>Date.now();
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
        if (chromeDriveAvailable()) {
          const existing = await reusableToken(message.expectedAccountId);
          if (!existing || existing.provider === 'chrome') await chromeToken(message.expectedAccountId, true);
        }
        assertActive();
        const id = crypto.randomUUID(), nonce = crypto.randomUUID() + crypto.randomUUID();
        const tab = await chrome.tabs.create({url: 'about:blank', active: true});
        if (tab.id === undefined) throw new DriveError('unavailable', '无法打开授权页面。');
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
        let token = await read<DriveToken>(key);
        if (chromeDriveAvailable() && (token?.provider === 'chrome' || await readChromeConnection(message.accountId))) {
          token = await chromeToken(message.accountId, false);
        }
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
        await nativeWrites;
        const previousToken = await read<DriveToken>(tokenKey(message.accountId));
        if (chromeDriveAvailable()) {
          await chrome.storage.local.remove(chromeConnectionKey(message.accountId));
          if (previousToken?.provider === 'chrome') await chrome.identity.removeCachedAuthToken({token: previousToken.accessToken}).catch(() => {});
        }
        await chrome.storage.session.remove(tokenKey(message.accountId));
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
