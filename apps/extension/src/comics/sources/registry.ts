import type {FileSourceDriver, SourceAccessChange, SourceProvider} from './contracts';

const drivers = new Map<string, SourceProvider>();
const listeners = new Set<(change: SourceAccessChange) => Promise<void>>();
const accountListeners = new Set<() => void>();
export function registerSourceDriver(input: FileSourceDriver | SourceProvider): () => void {
  const driver:SourceProvider='open' in input?{
    id:input.id,get label(){return input.label;},cachePages:input.cachePages,cacheRanges:input.cacheRanges,isConfigured:input.isConfigured,
    files:{open:input.open,select:input.select},subscribe:input.subscribe,
    connection:{list:input.listAccounts,subscribe:input.subscribeAccounts,describe:input.describeAccount,disconnect:input.disconnect},
  }:input;
  if (!/^[a-z][a-z0-9-]*$/.test(driver.id) || drivers.has(driver.id)) throw Error('来源标识无效或重复。');
  drivers.set(driver.id, driver);
  const unsubscribe = driver.subscribe?.(async change => {
    for (const listener of listeners) await listener(change);
  });
  const unsubscribeAccounts = driver.connection?.subscribe?.(() => {for (const listener of accountListeners) listener();});
  return () => { unsubscribe?.(); unsubscribeAccounts?.(); if (drivers.get(driver.id) === driver) drivers.delete(driver.id); };
}
export const getSourceDriver = (id: string) => drivers.get(id);
export const listSourceDrivers = () => [...drivers.values()];
export function requireSourceDriver(id: string): SourceProvider {
  const driver = getSourceDriver(id);
  if (!driver) throw Error('此来源未启用，请启用对应来源后重试。');
  return driver;
}
export function onSourceAccessChanged(listener: (change: SourceAccessChange) => Promise<void>) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function onSourceAccountsChanged(listener: () => void) {
  accountListeners.add(listener);
  return () => {accountListeners.delete(listener);};
}
