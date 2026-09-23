import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaults } from '../src/types';
import { saveSettings, settings } from '../src/comics/application/preferences';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
it('keeps known preferences while discarding old concurrency and backend overrides', async () => {
  localStorage.setItem('nc-settings', JSON.stringify({ requestConcurrency: 1, autoTranslate: true, apiBase: 'https://wrong.example', language: 'en' }));
  await saveSettings(settings());
  const stored = JSON.parse(localStorage.getItem('nc-settings')!);
  expect(stored.language).toBe('en');
  expect(stored).not.toHaveProperty('requestConcurrency'); expect(stored).not.toHaveProperty('apiBase'); expect(stored).not.toHaveProperty('autoTranslate');
});
it('preserves disabled/unlimited translation budgets and rejects malformed preferences', async () => {
  await saveSettings({ ...defaults, cacheLimitMb: 0 }); expect(settings().cacheLimitMb).toBe(0);
  await saveSettings({ ...defaults, cacheLimitMb: -1 }); expect(settings().cacheLimitMb).toBe(-1);
  localStorage.setItem('nc-settings', JSON.stringify({ cacheLimitMb: -999, textScale: -10 }));
  expect(settings()).toMatchObject({ cacheLimitMb: defaults.cacheLimitMb, textScale: 1 });
});
