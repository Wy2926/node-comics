import type {FileSourceDriver, SourceAccessChange} from './contracts';

const drivers = new Map<string, FileSourceDriver>();
const listeners = new Set<(change: SourceAccessChange) => Promise<void>>();
export function registerSourceDriver(driver: FileSourceDriver): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(driver.id) || drivers.has(driver.id)) throw Error('来源标识无效或重复。');
  drivers.set(driver.id, driver);
  const unsubscribe = driver.subscribe?.(async change => {
    for (const listener of listeners) await listener(change);
  });
  return () => { unsubscribe?.(); if (drivers.get(driver.id) === driver) drivers.delete(driver.id); };
}
export const getSourceDriver = (id: string) => drivers.get(id);
export const listSourceDrivers = () => [...drivers.values()];
export function requireSourceDriver(id: string): FileSourceDriver {
  const driver = getSourceDriver(id);
  if (!driver) throw Error('此来源未启用，请启用对应来源后重试。');
  return driver;
}
export function onSourceAccessChanged(listener: (change: SourceAccessChange) => Promise<void>) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
