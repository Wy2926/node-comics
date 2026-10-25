import {webcrypto} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loginRedirectUrl} from './auth-redirect';

afterEach(() => vi.unstubAllGlobals());

describe('extension login redirect', () => {
  it('keeps the browser-native redirect on desktop', async () => {
    const getRedirectURL = vi.fn(() => 'https://desktop.chromiumapp.org/oidc');
    vi.stubGlobal('chrome', {identity: {getRedirectURL}});
    expect(await loginRedirectUrl()).toBe('https://desktop.chromiumapp.org/oidc');
    expect(getRedirectURL).toHaveBeenCalledExactlyOnceWith('oidc');
  });

  it('derives the registered Firefox callback from the manifest ID, not the profile UUID', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('chrome', {runtime: {
      id: 'browser-assigned-id', getURL: () => 'moz-extension://random-profile-uuid/',
      getManifest: () => ({browser_specific_settings: {gecko: {id: 'comics@nodelane.net'}}}),
    }});
    expect(await loginRedirectUrl()).toBe('https://b6537bc59408f22ed5813efab806261a7e62bd16.extensions.allizom.org/oidc');
  });

  it('fails closed without a native redirect or a fixed Gecko ID', async () => {
    vi.stubGlobal('chrome', {runtime: {getManifest: () => ({})}});
    await expect(loginRedirectUrl()).rejects.toThrow('不支持安全登录');
  });

  it('uses the registered website callback for Safari without exposing its random origin', async () => {
    vi.stubGlobal('chrome', {runtime: {getURL: () => 'safari-web-extension://private-installation-id/'}});
    expect(await loginRedirectUrl('https://product.test/api/')).toBe('https://product.test/auth/callback/');
    expect(await loginRedirectUrl('http://127.0.0.1:5199')).toBe('http://127.0.0.1:5199/auth/callback/');
    await expect(loginRedirectUrl('http://product.test')).rejects.toThrow('HTTPS');
    await expect(loginRedirectUrl('https://user:secret@product.test')).rejects.toThrow('HTTPS');
  });
});
