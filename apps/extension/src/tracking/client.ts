import {catalog} from '../comics/repositories';

export interface TrackingView {
  configured: boolean; redirectUrl?: string; account?: {id: number; name: string}; enabled: boolean;
  suggestedMediaId?: number;
  binding?: {mediaId: number; title: string; offset: number; paused: boolean};
  job?: {status: 'pending' | 'syncing' | 'synced' | 'blocked'; progress: number; reason?: string};
}
const available = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id && !!chrome.runtime.sendMessage;
async function request<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!available()) throw Error('AniList tracking requires the installed extension');
  const response = await chrome.runtime.sendMessage({type: 'NC_TRACKING', command, ...args});
  if (!response?.ok) throw Error(response?.error ?? 'unavailable');
  return response.value as T;
}
export const trackingClient = {
  status: (comicId?: string): Promise<TrackingView> => available() ? request('status', {comicId}) : Promise.resolve({configured: false, enabled: false}),
  connect: () => request<void>('connect'),
  disconnect: () => request<void>('disconnect'),
  setEnabled: (enabled: boolean) => request<void>('enable', {enabled}),
  search: (query: string) => request<{id: number; title: string; chapters: number | null}[]>('search', {query}),
  bind: (comicId: string, mediaId: number, offset: number) => request<void>('bind', {comicId, mediaId, offset}),
  unbind: (comicId: string) => request<void>('unbind', {comicId}),
  retry: (comicId: string) => request<void>('retry', {comicId}),
  pause: (comicId: string, paused: boolean) => request<void>('pause', {comicId, paused}),
  resetBaseline: (comicId: string) => request<void>('reset-baseline', {comicId}),
  subscribe: (listener: () => void) => catalog.subscribe(change => {
    if (change.table === 'trackingJobs' || change.table === 'trackingBindings' || change.table === 'metadata' && change.ids.includes('tracking-session')) listener();
  }),
};
export function wakeTracking() {
  if (available()) void request('wake').catch(() => { /* Startup/alarm recovery owns durable work. */ });
}
