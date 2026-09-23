import type {SourceConnection} from '../domain';
import type {SourceSelection} from '../sources/contracts';
import {getSourceDriver, listSourceDrivers, requireSourceDriver} from '../sources/registry';

export type {SourceSelection} from '../sources/contracts';

export function sourceImportOptions(): {id: string; label: string; configured: boolean}[] {
  return listSourceDrivers().filter(driver => !!driver.select).map(driver => ({
    id: driver.id, label: driver.label, configured: driver.isConfigured?.() ?? true,
  }));
}

export async function selectSourceFiles(providerId: string, connection?: SourceConnection, signal?: AbortSignal): Promise<SourceSelection> {
  signal?.throwIfAborted();
  const driver = requireSourceDriver(providerId);
  if (!driver.select) throw Error('此来源不提供文件选择入口。');
  if (driver.isConfigured?.() === false) throw Error('此来源尚未配置。');
  const selection = await driver.select(connection, signal);
  signal?.throwIfAborted();
  if (selection.connection.provider !== driver.id || !selection.connection.id)
    throw Error('所选文件的来源身份不匹配。');
  if (connection && (selection.connection.id !== connection.id || selection.connection.accountId !== connection.accountId))
    throw Error('所选来源账户与原连接不匹配。');
  return selection;
}

export const chooseSourceFiles = (providerId: string, signal?: AbortSignal) => selectSourceFiles(providerId, undefined, signal);

export function connectionCapabilities(connection: SourceConnection) {
  const driver = getSourceDriver(connection.provider);
  return {providerLabel: driver?.label ?? connection.provider,
    canReconnect: !!driver?.select && driver.isConfigured?.() !== false,
    canDisconnect: !!driver?.disconnect};
}
