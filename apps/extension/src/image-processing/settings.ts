import type {ProcessingProfile} from './contracts';
import {processingAdapter} from './registry';
import {requireHostAccess} from '../host-permissions';
import {msg} from '../i18n/runtime';

export const processingSettingsKey = 'nc-image-processing';
export const processingCacheLimitsMb = [128, 512, 1024, 10240];
export const defaultProcessingCacheLimitMb = 10240;
export interface ProcessingSettings {enabled: boolean; activeId: string; profiles: ProcessingProfile[]; cacheLimitMb: number; cacheRevision?: string;}
export const processingDefaults = (): ProcessingSettings => ({enabled: false, activeId: '', profiles: [], cacheLimitMb: defaultProcessingCacheLimitMb});
const listeners = new Set<() => void>();
export function normalizeSettings(value: unknown): ProcessingSettings {
  if (!value || typeof value !== 'object') return processingDefaults();
  const input = value as ProcessingSettings;
  const profiles = Array.isArray(input.profiles) ? input.profiles.filter(profile => profile && typeof profile.id === 'string'
    && typeof profile.name === 'string' && typeof profile.adapterId === 'string' && Number.isSafeInteger(profile.revision)
    && profile.revision > 0 && profile.settings && typeof profile.settings === 'object'
    && Object.values(profile.settings).every(value => typeof value === 'string')) : [];
  return {enabled: input.enabled === true, activeId: profiles.some(profile => profile.id === input.activeId) ? input.activeId : '', profiles,
    cacheLimitMb: processingCacheLimitsMb.includes(input.cacheLimitMb) ? input.cacheLimitMb : defaultProcessingCacheLimitMb,
    ...(typeof input.cacheRevision === 'string' ? {cacheRevision: input.cacheRevision} : {})};
}
export async function readProcessingSettings(): Promise<ProcessingSettings> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return normalizeSettings((await chrome.storage.local.get(processingSettingsKey))[processingSettingsKey]);
  try {return normalizeSettings(JSON.parse(localStorage.getItem(processingSettingsKey) ?? 'null'));} catch {return processingDefaults();}
}
export async function updateProcessingSettings(change: (previous: ProcessingSettings) => ProcessingSettings | Promise<ProcessingSettings>) {
  const run = async () => {
    const value = normalizeSettings(await change(await readProcessingSettings()));
    if (typeof chrome !== 'undefined' && chrome.storage?.local) await chrome.storage.local.set({[processingSettingsKey]: value});
    else {localStorage.setItem(processingSettingsKey, JSON.stringify(value)); for (const listener of listeners) listener();}
  };
  if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(processingSettingsKey, run);
  else await run();
}
export function subscribeProcessingSettings(listener: () => void) {
  listeners.add(listener);
  const changed = (changes: Record<string, unknown>, area: string) => {if (area === 'local' && processingSettingsKey in changes) listener();};
  const stored = (event: StorageEvent) => {if (event.key === processingSettingsKey || event.key === null) listener();};
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) chrome.storage.onChanged.addListener(changed);
  if (typeof window !== 'undefined') window.addEventListener('storage', stored);
  return () => {
    listeners.delete(listener);
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) chrome.storage.onChanged.removeListener(changed);
    if (typeof window !== 'undefined') window.removeEventListener('storage', stored);
  };
}
export async function saveProcessingProfile(adapterId: string, name: string, input: Record<string, string>, id?: string) {
  const adapter = processingAdapter(adapterId), settings = adapter.normalize(input);
  await requireHostAccess([new URL(adapter.request(settings).url).origin + '/*']);
  await updateProcessingSettings(previous => {
    const old = previous.profiles.find(profile => profile.id === id);
    if (id && !old) throw Error(msg('增强渠道不可用，请检查设置。'));
    const changed = old?.adapterId !== adapterId || JSON.stringify(old.settings) !== JSON.stringify(settings);
    const profile: ProcessingProfile = {id: old?.id ?? crypto.randomUUID(), adapterId, name: name.trim().slice(0, 80) || adapter.label,
      revision: old ? old.revision + Number(changed) : 1, settings};
    return {...previous, activeId: profile.id, profiles: [...previous.profiles.filter(item => item.id !== profile.id), profile]};
  });
}
export const activeProcessingProfile = (settings: ProcessingSettings) => settings.enabled ? settings.profiles.find(item => item.id === settings.activeId) : undefined;
/** Only changes that affect displayed pixels invalidate reader work. */
export function processingIdentity(settings: ProcessingSettings): string {
  const profile = activeProcessingProfile(settings);
  return profile ? JSON.stringify([profile.id, profile.revision, settings.cacheRevision]) : '';
}
