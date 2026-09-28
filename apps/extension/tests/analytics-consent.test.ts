import {afterEach, expect, it, vi} from 'vitest';
import type {AnalyticsPreferences} from '../src/analytics/prompt';

const external = vi.hoisted(() => ({
  subscribe: undefined as undefined | ((listener: () => void) => () => void),
  snapshot: undefined as undefined | (() => AnalyticsPreferences & {ready: boolean}),
  read: vi.fn<() => Promise<AnalyticsPreferences>>(),
}));
vi.mock('react', () => ({useSyncExternalStore: (subscribe: typeof external.subscribe, snapshot: typeof external.snapshot) => {
  external.subscribe = subscribe;
  external.snapshot = snapshot;
  return snapshot!();
}}));
vi.mock('../src/analytics/client', () => ({analyticsAvailable: () => true, readAnalyticsPreferences: external.read}));

afterEach(() => {vi.unstubAllGlobals(); vi.resetModules();});

it('refreshes a resumed page and publishes a changed consent epoch even if enabled stays true', async () => {
  const windowEvents = new Map<string, () => void>();
  const documentEvents = new Map<string, () => void>();
  let storageChanged!: (changes: Record<string, unknown>, area: string) => void;
  vi.stubGlobal('window', {addEventListener: (name: string, callback: () => void) => windowEvents.set(name, callback)});
  vi.stubGlobal('document', {hidden: false, addEventListener: (name: string, callback: () => void) => documentEvents.set(name, callback)});
  vi.stubGlobal('chrome', {
    storage: {onChanged: {addListener: (callback: typeof storageChanged) => {storageChanged = callback;}}},
    permissions: {onRemoved: {addListener: vi.fn()}},
  });
  external.read.mockResolvedValue({enabled: true, promptHandled: true, consentedAt: 1000});
  const {useAnalyticsPreferences} = await import('../src/analytics/consent');
  useAnalyticsPreferences();
  const notify = vi.fn(), unsubscribe = external.subscribe!(notify);
  await vi.waitFor(() => expect(external.snapshot!()).toMatchObject({ready: true, enabled: true, consentedAt: 1000}));
  notify.mockClear();
  // No intermediate storage event reaches this frozen page; pageshow must refresh it.
  external.read.mockResolvedValue({enabled: true, promptHandled: true, consentedAt: 2000});
  windowEvents.get('pageshow')!();
  await vi.waitFor(() => expect(external.snapshot!()).toMatchObject({enabled: true, consentedAt: 2000}));
  expect(notify).toHaveBeenCalledTimes(1);
  // Coalesced notifications may both read the final true state; epoch changes still publish.
  external.read.mockResolvedValue({enabled: true, promptHandled: true, consentedAt: 3000});
  storageChanged({'nc-analytics-v1': {oldValue: {consent: true, consented_at: 2000}, newValue: {consent: false}}}, 'local');
  storageChanged({'nc-analytics-v1': {oldValue: {consent: false}, newValue: {consent: true, consented_at: 3000}}}, 'local');
  await vi.waitFor(() => expect(external.snapshot!()).toMatchObject({enabled: true, consentedAt: 3000}));
  expect(notify).toHaveBeenCalledTimes(2);
  expect(windowEvents.has('focus')).toBe(true);
  expect(documentEvents.has('visibilitychange')).toBe(true);
  unsubscribe();
});
