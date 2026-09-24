import {DriveError} from './errors';
import {validDriveIdentifier, type DriveFileReference} from './metadata';

export interface PendingDriveBridge {
  id: string; nonce: string; tabId: number; url: string; expiresAt: number;
  expectedAccountId?: string; documentId?: string; initialized?: boolean; consumed?: boolean;
  reusedToken?: { accountId: string; generation: string; expiresAt: number; accessToken: string };
  oauth?: {state: string; phase: 'away' | 'returned'};
}
export interface DriveBridgePayload { nonce: string; accessToken: string; expiresIn: number; files: DriveFileReference[]; }
export function validateBridgeSender(pending: PendingDriveBridge, sender: chrome.runtime.MessageSender,
  extensionId: string, currentTabUrl: string | undefined, now = Date.now()) {
  if (pending.consumed || pending.expiresAt <= now || sender.id !== extensionId || sender.frameId !== 0 ||
      sender.tab?.id !== pending.tabId || sender.url !== pending.url || currentTabUrl !== pending.url ||
      (pending.documentId !== undefined && sender.documentId !== pending.documentId))
    throw new DriveError('invalid-bridge', 'Google Drive 授权页面已失效，请重新连接。');
  const url = new URL(sender.url);
  if (url.protocol !== 'https:' || url.hash !== `#state=${pending.nonce}`) throw new DriveError('invalid-bridge', '授权页面身份不匹配。');
}
export function parseBridgePayload(value: unknown, pending: PendingDriveBridge): DriveBridgePayload {
  if (!value || typeof value !== 'object') throw new DriveError('invalid-bridge', '授权返回无效。');
  const input = value as Record<string, unknown>;
  if (pending.oauth && (pending.oauth.phase !== 'returned' || input.oauthState !== pending.oauth.state))
    throw new DriveError('invalid-bridge', '授权返回身份不匹配。');
  if (input.nonce !== pending.nonce || typeof input.accessToken !== 'string' ||
      input.accessToken.length < 10 || input.accessToken.length > 8192 || /\s/.test(input.accessToken) ||
      typeof input.expiresIn !== 'number' || !Number.isFinite(input.expiresIn) || input.expiresIn < 30 || input.expiresIn > 86_400 ||
      !Array.isArray(input.files) || input.files.length > 100)
    throw new DriveError('invalid-bridge', '授权返回无效。');
  const files: DriveFileReference[] = [];
  const seen = new Set<string>();
  for (const raw of input.files) {
    if (!raw || typeof raw !== 'object' || !validDriveIdentifier(raw.fileId) ||
        (raw.resourceKey !== undefined && !validDriveIdentifier(raw.resourceKey))) throw new DriveError('invalid-bridge', '选择的文件标识无效。');
    if (!seen.has(raw.fileId)) { files.push({fileId: raw.fileId, resourceKey: raw.resourceKey}); seen.add(raw.fileId); }
  }
  return {nonce: pending.nonce, accessToken: input.accessToken, expiresIn: input.expiresIn, files};
}
