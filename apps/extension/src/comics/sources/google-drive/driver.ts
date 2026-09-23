import type {SourceConnection} from '../../domain';
import type {FileSourceDriver, SourceSelection} from '../contracts';
import {chooseDriveFiles, disconnectDrive, isDriveConfigured, onDriveAccessChanged, openDriveSource} from './index';
import {DriveError} from './errors';
import {validDriveIdentifier, type DriveBinding} from './metadata';

const provider = 'google-drive';
const connectionId = (accountId: string) => `drive:${accountId}`;
function accountFor(connection: SourceConnection): string {
  if (connection.provider !== provider || !validDriveIdentifier(connection.accountId) || connection.id !== connectionId(connection.accountId))
    throw new DriveError('account-mismatch', 'Google Drive 来源账户无效，请重新连接原账户。');
  return connection.accountId;
}
function snapshotBinding(value: unknown): DriveBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DriveError('invalid-response', 'Google Drive 文件版本资料不完整，请重新导入。');
  const snapshot = value as Record<string, unknown>;
  if (!validDriveIdentifier(snapshot.accountId) || !validDriveIdentifier(snapshot.fileId) ||
      (snapshot.resourceKey !== undefined && !validDriveIdentifier(snapshot.resourceKey)) ||
      typeof snapshot.version !== 'string' || !/^\d+$/.test(snapshot.version) ||
      typeof snapshot.size !== 'number' || !Number.isSafeInteger(snapshot.size) || snapshot.size <= 0)
    throw new DriveError('invalid-response', 'Google Drive 文件版本资料无效，请重新导入。');
  return Object.freeze({accountId: snapshot.accountId, fileId: snapshot.fileId,
    ...(snapshot.resourceKey === undefined ? {} : {resourceKey: snapshot.resourceKey}),
    version: snapshot.version, size: snapshot.size});
}

export const googleDriveDriver: FileSourceDriver = {
  id: provider,
  label: 'Google Drive',
  cachePages: true,
  cacheRanges: true,
  isConfigured: isDriveConfigured,
  async select(connection, signal): Promise<SourceSelection> {
    signal?.throwIfAborted();
    const expectedAccount = connection && accountFor(connection);
    const selected = await chooseDriveFiles(expectedAccount, signal);
    signal?.throwIfAborted();
    if (!validDriveIdentifier(selected.account.id) || (expectedAccount && selected.account.id !== expectedAccount))
      throw new DriveError('account-mismatch', '请选择原来连接的 Google Drive 账户。');
    return {
      connection: {id: connectionId(selected.account.id), provider, accountId: selected.account.id, displayName: selected.account.displayName},
      files: selected.files.map(file => {
        if (file.format !== 'cbz' && file.format !== 'image')
          throw new DriveError('unsupported-format', 'Google Drive 仅支持 CBZ/ZIP 和独立图片直接阅读。');
        const snapshot = snapshotBinding({accountId: selected.account.id, fileId: file.fileId, resourceKey: file.resourceKey, version: file.version, size: file.size});
        return {id: file.fileId, name: file.name, format: file.format,
          sourceKey: 'drive:' + JSON.stringify([selected.account.id, file.fileId, file.version]),
          locator: {...snapshot}, snapshot: {...snapshot}};
      }),
    };
  },
  async open(context) {
    context.signal?.throwIfAborted();
    const accountId = accountFor(context.connection);
    if (!['cbz', 'zip', 'image'].includes(context.format))
      throw new DriveError('unsupported-format', 'Google Drive 仅支持 CBZ/ZIP 和独立图片直接阅读。');
    const snapshot = snapshotBinding(context.revision.sourceSnapshot);
    if (snapshot.accountId !== accountId || context.binding.connectionId !== context.connection.id)
      throw new DriveError('account-mismatch', '此漫画属于另一个 Google Drive 账户，请连接原账户。');
    if (context.binding.providerItemId !== snapshot.fileId)
      throw new DriveError('invalid-response', 'Google Drive 文件与冻结版本不匹配，请重新导入。');
    return openDriveSource(snapshot, context.signal);
  },
  async disconnect(connection) { await disconnectDrive(accountFor(connection)); },
  subscribe(listener) {
    return onDriveAccessChanged((accountId, fileId) => listener({connectionId: connectionId(accountId), ...(fileId === undefined ? {} : {itemId: fileId})}));
  },
};
