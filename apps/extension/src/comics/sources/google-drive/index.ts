import {DriveError, type DriveErrorCode} from './errors';
import {fetchDriveMetadata, validDriveIdentifier, type DriveAccount, type DriveBinding, type DriveFileMetadata} from './metadata';
import {DriveRangeSource, type DriveRangeOptions} from './range-source';
export {isDriveConfigured} from './config';
export {DriveError} from './errors';
export {DriveRangeSource} from './range-source';
export type {DriveAccount, DriveBinding, DriveFileMetadata} from './metadata';
export interface DriveSelection { account: DriveAccount; files: DriveFileMetadata[]; }

async function message(input: Record<string, unknown>) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) throw new DriveError('not-configured', '请在浏览器插件中连接 Google Drive。');
  const result = await chrome.runtime.sendMessage(input);
  if (!result?.ok) throw new DriveError((result?.code ?? 'unavailable') as DriveErrorCode, result?.error ?? 'Google Drive 连接失败。');
  return result;
}
export async function chooseDriveFiles(expectedAccountId?: string, signal?: AbortSignal): Promise<DriveSelection> {
  signal?.throwIfAborted();
  const {id} = await message({type: 'NC_DRIVE_CONNECT', expectedAccountId});
  const expiresAt = Date.now() + 10 * 60_000;
  while (Date.now() < expiresAt) {
    signal?.throwIfAborted();
    const result = await message({type: 'NC_DRIVE_STATUS', id});
    signal?.throwIfAborted();
    if (!result.pending) return {account: result.account, files: result.files};
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 500);
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
      signal?.addEventListener('abort', abort, {once: true});
    });
  }
  throw new DriveError('cancelled', 'Google Drive 连接已超时，请重试。');
}
const sources = new Map<string, Set<DriveRangeSource>>();
type DriveAccessListener = (accountId: string, fileId?: string) => Promise<void>;
const accessListeners = new Set<DriveAccessListener>();
let listening = false;
/** Access changes carry provider identity only; cache and catalog policy belong to the caller. */
export function onDriveAccessChanged(listener: DriveAccessListener): () => void {
  accessListeners.add(listener);
  if (!listening && typeof chrome !== 'undefined' && chrome.runtime?.id) {
    listening = true;
    chrome.runtime.onMessage.addListener((input, sender) => {
      if (sender.id === chrome.runtime.id && input?.type === 'NC_DRIVE_DISCONNECTED' && validDriveIdentifier(input.accountId))
        void accessChanged(input.accountId).catch(() => {});
    });
  }
  return () => { accessListeners.delete(listener); };
}
async function accessChanged(accountId: string, fileId?: string) {
  const active = sources.get(accountId);
  if (active) await Promise.all([...active].filter(source => fileId === undefined || source.binding.fileId === fileId).map(source => source.close()));
  await Promise.all([...accessListeners].map(listener => listener(accountId, fileId)));
}
export async function disconnectDrive(accountId: string) {
  await message({type: 'NC_DRIVE_DISCONNECT', accountId});
  await accessChanged(accountId);
}
export async function openDriveSource(binding: DriveBinding, signal?: AbortSignal,
  options: Omit<DriveRangeOptions, 'token' | 'onAccessLost'> = {}): Promise<DriveRangeSource> {
  signal?.throwIfAborted();
  const session = await message({type: 'NC_DRIVE_TOKEN', accountId: binding.accountId});
  const token = async () => {
    const current = await message({type: 'NC_DRIVE_TOKEN', accountId: binding.accountId, generation: session.generation});
    return current.accessToken as string;
  };
  const metadata = await fetchDriveMetadata(binding, await token(), signal, options.fetch).catch(async error => {
    if (error instanceof DriveError && ['access-revoked', 'download-forbidden'].includes(error.code))
      await accessChanged(binding.accountId, binding.fileId);
    throw error;
  });
  if (metadata.version !== binding.version || metadata.size !== binding.size) throw new DriveError('source-changed', 'Google Drive 文件已变化，请重新选择此文件载入当前内容。');
  const source = new DriveRangeSource(binding, {...options, token,
    onAccessLost: async reference => { await accessChanged(reference.accountId, reference.fileId); }});
  let set = sources.get(binding.accountId);
  if (!set) { set = new Set(); sources.set(binding.accountId, set); }
  set.add(source);
  const close = source.close.bind(source);
  source.close = async () => { set.delete(source); if (!set.size) sources.delete(binding.accountId); await close(); };
  return source;
}
