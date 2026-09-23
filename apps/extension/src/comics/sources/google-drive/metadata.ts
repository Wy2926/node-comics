import {checkDriveResponse, DriveError} from './errors';

export interface DriveAccount { id: string; displayName: string; emailAddress?: string; }
export interface DriveFileReference { fileId: string; resourceKey?: string; }
export interface DriveFileMetadata extends DriveFileReference {
  name: string; mimeType: string; size: number; version: string; modifiedTime?: string;
  format: 'cbz';
}
export interface DriveBinding extends DriveFileReference { accountId: string; version: string; size: number; }
export type DriveFetch = typeof fetch;
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const identifier = /^[A-Za-z0-9_-]{1,256}$/;
export function validDriveIdentifier(value: unknown): value is string { return typeof value === 'string' && identifier.test(value); }
export function driveHeaders(token: string, reference?: DriveFileReference): Headers {
  const headers = new Headers({Authorization: `Bearer ${token}`});
  if (reference) {
    if (!validDriveIdentifier(reference.fileId) || (reference.resourceKey !== undefined && !validDriveIdentifier(reference.resourceKey)))
      throw new DriveError('invalid-response', '无效的 Google Drive 文件标识。');
    if (reference.resourceKey) headers.set('X-Goog-Drive-Resource-Keys', `${reference.fileId}/${reference.resourceKey}`);
  }
  return headers;
}
export async function fetchDriveAccount(token: string, signal?: AbortSignal, request: DriveFetch = fetch): Promise<DriveAccount> {
  const response = await request(`${DRIVE_API}/about?fields=user(permissionId,displayName,emailAddress)`, {
    headers: driveHeaders(token), signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
  });
  await checkDriveResponse(response);
  const body = await response.json();
  if (!validDriveIdentifier(body?.user?.permissionId)) throw new DriveError('invalid-response', 'Google Drive 未返回可核验的账户身份。');
  const emailAddress = typeof body.user.emailAddress === 'string' ? body.user.emailAddress.trim().slice(0,320) : undefined;
  return {id: body.user.permissionId, displayName: typeof body.user.displayName === 'string' ? body.user.displayName.slice(0,256) : 'Google Drive',
    ...(emailAddress ? {emailAddress} : {})};
}
export function driveFormat(name: string, mimeType: string): 'cbz' {
  if (mimeType.startsWith('application/vnd.google-apps.')) throw new DriveError('unsupported-format', '在线文档、文件夹和快捷方式暂不支持云端直接阅读。');
  if (!mimeType.toLowerCase().startsWith('image/') && /\.(zip|cbz)$/i.test(name)) return 'cbz';
  throw new DriveError('unsupported-format', 'Google Drive 仅支持 CBZ/ZIP 漫画文件，不支持图片；PDF、MOBI、RAR 请下载后从本地导入。');
}
export async function fetchDriveMetadata(reference: DriveFileReference, token: string, signal?: AbortSignal, request: DriveFetch = fetch): Promise<DriveFileMetadata> {
  const headers = driveHeaders(token, reference);
  const fields = 'id,name,mimeType,size,version,modifiedTime,resourceKey,capabilities(canDownload),trashed';
  const response = await request(`${DRIVE_API}/files/${encodeURIComponent(reference.fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`, {
    headers, signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
  });
  await checkDriveResponse(response);
  const body = await response.json();
  if (body?.trashed) throw new DriveError('unavailable', '此 Google Drive 文件已移入回收站。');
  if (body?.capabilities?.canDownload === false) throw new DriveError('download-forbidden', 'Google Drive 禁止下载此文件。');
  const size = Number(body?.size);
  if (body?.id !== reference.fileId || typeof body.name !== 'string' || typeof body.mimeType !== 'string' ||
      body.capabilities?.canDownload !== true || !Number.isSafeInteger(size) || size <= 0 ||
      typeof body.version !== 'string' || !/^\d+$/.test(body.version))
    throw new DriveError('invalid-response', 'Google Drive 文件缺少可核验的大小、版本或下载权限。');
  const resourceKey = reference.resourceKey ?? body.resourceKey;
  if (resourceKey !== undefined && !validDriveIdentifier(resourceKey)) throw new DriveError('invalid-response', '无效的资源密钥。');
  return {fileId: body.id, resourceKey, name: body.name.slice(0,1024), mimeType: body.mimeType,
    size, version: body.version, modifiedTime: typeof body.modifiedTime === 'string' ? body.modifiedTime : undefined,
    format: driveFormat(body.name, body.mimeType)};
}
