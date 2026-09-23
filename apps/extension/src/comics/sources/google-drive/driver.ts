import type {FileSourceDriver, SourceAccount, SourceSelection} from '../contracts';
import {chooseDriveFiles, disconnectDrive, isDriveConfigured, listDriveAccounts, onDriveAccountsChanged, onDriveAccessChanged, openDriveSource} from './index';
import {DriveError} from './errors';
import {validDriveIdentifier, type DriveBinding} from './metadata';
import {msg} from '../../../i18n/runtime';

const provider = 'google-drive';
const connectionId = (accountId: string) => `drive:${accountId}`;
function accountFor(connection: SourceAccount): string {
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
  async listAccounts() {
    return (await listDriveAccounts()).map(({account,status})=>({
      id:connectionId(account.id),provider,accountId:account.id,displayName:account.displayName,status,
      ...(account.emailAddress?{accountMetadata:{emailAddress:account.emailAddress}}:{}),
    }));
  },
  subscribeAccounts: onDriveAccountsChanged,
  describeAccount(connection) {
    return [
      ...(connection.accountMetadata?.emailAddress ? [{id:'email',label:msg('邮箱'),value:connection.accountMetadata.emailAddress}] : []),
      {id:'account',label:msg('账户标识'),value:accountFor(connection)},
    ];
  },
  async select(connection, signal): Promise<SourceSelection> {
    signal?.throwIfAborted();
    const expectedAccount = connection && accountFor(connection);
    const selected = await chooseDriveFiles(expectedAccount, signal);
    signal?.throwIfAborted();
    if (!validDriveIdentifier(selected.account.id) || (expectedAccount && selected.account.id !== expectedAccount))
      throw new DriveError('account-mismatch', '请选择原来连接的 Google Drive 账户。');
    return {
      connection: {id: connectionId(selected.account.id), provider, accountId: selected.account.id, displayName: selected.account.displayName,
        ...(selected.account.emailAddress ? {accountMetadata:{emailAddress:selected.account.emailAddress}} : {})},
      files: selected.files.map(file => {
        if (file.format !== 'cbz')
          throw new DriveError('unsupported-format', 'Google Drive 仅支持 CBZ/ZIP 漫画文件。');
        const snapshot = snapshotBinding({accountId: selected.account.id, fileId: file.fileId, resourceKey: file.resourceKey, version: file.version, size: file.size});
        return {id: file.fileId, name: file.name, format: file.format,
          locator: {...snapshot}, snapshot: {...snapshot}};
      }),
    };
  },
  async open(context) {
    context.signal?.throwIfAborted();
    const accountId = accountFor(context.connection);
    if (!['cbz', 'zip'].includes(context.format))
      throw new DriveError('unsupported-format', 'Google Drive 仅支持 CBZ/ZIP 漫画文件。');
    const snapshot = snapshotBinding(context.sourceSnapshot);
    if (snapshot.accountId !== accountId || context.source.connectionId !== context.connection.id)
      throw new DriveError('account-mismatch', '此漫画属于另一个 Google Drive 账户，请连接原账户。');
    if (context.source.providerItemId !== snapshot.fileId)
      throw new DriveError('invalid-response', 'Google Drive 文件与当前来源不匹配，请重新选择文件。');
    return openDriveSource(snapshot, context.signal);
  },
  async disconnect(connection) { await disconnectDrive(accountFor(connection)); },
  subscribe(listener) {
    return onDriveAccessChanged((accountId, fileId) => listener({connectionId: connectionId(accountId), ...(fileId === undefined ? {} : {itemId: fileId})}));
  },
};
