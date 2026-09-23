export type DriveErrorCode = 'not-configured' | 'reconnect-required' | 'account-mismatch' |
  'access-revoked' | 'download-forbidden' | 'unavailable' | 'offline' | 'source-changed' |
  'range-unsupported' | 'invalid-response' | 'budget-exceeded' | 'unsupported-format' |
  'invalid-bridge' | 'cancelled';

export class DriveError extends Error {
  constructor(readonly code: DriveErrorCode, message: string) { super(message); this.name = 'DriveError'; }
}

export async function checkDriveResponse(response: Response): Promise<void> {
  if (response.ok) return;
  // A transient 401 must not delete cached books or revoke the connection.
  if (response.status === 401) throw new DriveError('reconnect-required', 'Google Drive 登录已过期，请重新连接。');
  if (response.status === 404) throw new DriveError('unavailable', 'Google Drive 文件已移除或当前账户无权访问。');
  if (response.status === 403) {
    const body = await response.json().catch(() => null) as {error?: {errors?: {reason?: string}[]}} | null;
    const reasons = body?.error?.errors?.map(error => error.reason) ?? [];
    if (reasons.some(reason => ['insufficientFilePermissions', 'appNotAuthorizedToFile', 'insufficientPermissions'].includes(reason ?? '')))
      throw new DriveError('access-revoked', '此 Google Drive 文件的访问授权已撤销。');
    if (reasons.some(reason => ['cannotDownloadFile', 'downloadRestrictedForRevision', 'fileNotDownloadable'].includes(reason ?? '')))
      throw new DriveError('download-forbidden', 'Google Drive 禁止下载此文件。');
  }
  throw new DriveError('unavailable', `Google Drive 请求暂不可用（${response.status}）。`);
}
