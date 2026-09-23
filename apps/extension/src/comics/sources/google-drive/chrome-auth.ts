import {DriveError} from './errors';
import {fetchDriveAccount, type DriveAccount} from './metadata';

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ACCOUNT_CACHE_MS = 5 * 60_000;
const MAX_ACCOUNT_CACHE = 8;
interface AccountVerification { expiresAt: number; account: Promise<DriveAccount>; }
const accounts = new Map<string, AccountVerification>();

export function chromeDriveAvailable(): boolean {
  try {
    // Edge exposes a partial chrome.identity API, but does not support getAuthToken.
    if (typeof navigator !== 'undefined' && /\bEdg(?:A|iOS)?\//.test(navigator.userAgent)) return false;
    if (typeof chrome === 'undefined' || typeof chrome.identity?.getAuthToken !== 'function') return false;
    const oauth = chrome.runtime.getManifest().oauth2;
    return typeof oauth?.client_id === 'string' && oauth.client_id.trim().length > 0 &&
      Array.isArray(oauth.scopes) && oauth.scopes.includes(DRIVE_FILE_SCOPE);
  } catch {
    return false;
  }
}

async function requestToken(interactive: boolean): Promise<string> {
  let result: chrome.identity.GetAuthTokenResult;
  try {
    result = await chrome.identity.getAuthToken({interactive, scopes: [DRIVE_FILE_SCOPE], enableGranularPermissions: true});
  } catch (error) {
    // Chrome errors can include request details. Never forward their messages to callers or logs.
    const cancelled = error instanceof Error && /user.*(?:cancel|did not approve)|cancelled|canceled/i.test(error.message);
    throw new DriveError(cancelled ? 'cancelled' : 'reconnect-required', cancelled ?
      '已取消 Google Drive 授权。' : 'Google Drive 需要重新连接，请点击连接账户后重试。');
  }
  if (!result || typeof result.token !== 'string' || result.token.length < 10 || result.token.length > 8192 ||
      !/^[A-Za-z0-9._~+\/-]+=*$/.test(result.token))
    throw new DriveError('reconnect-required', 'Google Drive 未返回有效凭据，请重新连接。');
  if (!Array.isArray(result.grantedScopes) || result.grantedScopes.some(scope => typeof scope !== 'string' || !scope) ||
      !result.grantedScopes.includes(DRIVE_FILE_SCOPE))
    throw new DriveError('reconnect-required', '尚未授予所选 Google Drive 文件的访问权限，请重新连接并允许访问。');
  return result.token;
}

function verifyAccount(accessToken: string): Promise<DriveAccount> {
  const now = Date.now();
  for (const [token, cached] of accounts) if (cached.expiresAt <= now) accounts.delete(token);
  const cached = accounts.get(accessToken);
  if (cached) return cached.account;
  while (accounts.size >= MAX_ACCOUNT_CACHE) accounts.delete(accounts.keys().next().value!);
  const entry: AccountVerification = {expiresAt: now + ACCOUNT_CACHE_MS, account: fetchDriveAccount(accessToken)};
  accounts.set(accessToken, entry);
  void entry.account.catch(() => {
    if (accounts.get(accessToken) === entry) accounts.delete(accessToken);
  });
  return entry.account;
}

export async function requestChromeDriveToken(interactive: boolean, expectedAccountId?: string): Promise<{accessToken: string; account: DriveAccount}> {
  if (!chromeDriveAvailable()) throw new DriveError('not-configured', '当前浏览器未配置 Chrome 托管的 Google Drive 连接。');
  let accessToken = await requestToken(interactive);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const account = await verifyAccount(accessToken);
      if (expectedAccountId !== undefined && account.id !== expectedAccountId)
        throw new DriveError('account-mismatch', '当前 Google Drive 账户与此漫画绑定的账户不同，请连接原账户。');
      return {accessToken, account: {...account}};
    } catch (error) {
      // Only a Drive API 401 proves this cached credential is invalid. Refresh once without prompting.
      if (error instanceof DriveError && error.code === 'reconnect-required' && attempt === 0) {
        accounts.delete(accessToken);
        try { await chrome.identity.removeCachedAuthToken({token: accessToken}); }
        catch { throw new DriveError('reconnect-required', 'Google Drive 凭据无法更新，请重新连接。'); }
        accessToken = await requestToken(false);
        continue;
      }
      if (error instanceof DriveError) throw error;
      throw new DriveError('offline', '无法核验 Google Drive 账户，请检查网络后重试。');
    }
  }
  throw new DriveError('reconnect-required', 'Google Drive 登录已过期，请重新连接。');
}
