import {describe, expect, it, vi} from 'vitest';
import {createAnalyticsPreferences} from '../src/analytics/prompt';

function fixture(saved: {prompt?: boolean; consent?: boolean} = {}) {
  let data = {...saved};
  let nativePermission = true;
  const setConsent = vi.fn(async (wanted: boolean) => {
    data.consent = wanted && nativePermission;
    return data.consent;
  });
  const create = () => createAnalyticsPreferences({
    read: async () => ({...data}),
    writePrompt: async handled => {data.prompt = handled;},
    enabled: async () => data.consent === true && nativePermission,
    setConsent,
  });
  return {
    create, setConsent, controller: create(),
    get saved() {return data;},
    clearAnalytics() {delete data.consent;},
    set nativePermission(value: boolean) {nativePermission = value;},
  };
}

describe('optional analytics bookshelf prompt', () => {
  it('keeps a new installation off despite native permission, without a consent mutation', async () => {
    const f = fixture();
    expect(await f.controller.status()).toEqual({enabled: false, promptHandled: false});
    expect(await f.create().status()).toEqual({enabled: false, promptHandled: false});
    expect(f.setConsent).not.toHaveBeenCalled();
    expect(f.saved).toEqual({prompt: false});
  });

  it.each([true, false])('does not ask again about an older explicit setting: %s', async consent => {
    const f = fixture({consent});
    expect(await f.controller.status()).toEqual({enabled: consent, promptHandled: true});
    f.clearAnalytics();
    expect(await f.create().status()).toEqual({enabled: false, promptHandled: true});
    expect(f.setConsent).not.toHaveBeenCalled();
  });

  it('persists decline/close independently of identity cleanup and a restarted background', async () => {
    const f = fixture();
    expect(await f.controller.choose(false)).toEqual({enabled: false, promptHandled: true});
    f.clearAnalytics();
    expect(await f.create().status()).toEqual({enabled: false, promptHandled: true});
  });

  it('shares the choice with settings and keeps the prompt dismissed after withdrawal', async () => {
    const f = fixture();
    expect(await f.controller.choose(true)).toEqual({enabled: true, promptHandled: true});
    expect(await f.create().status()).toEqual({enabled: true, promptHandled: true});
    expect(await f.controller.choose(false)).toEqual({enabled: false, promptHandled: true});
    f.clearAnalytics();
    expect(await f.create().status()).toEqual({enabled: false, promptHandled: true});
  });

  it('does not hide an unanswered prompt when the browser rejects enabling analytics', async () => {
    const f = fixture();
    await f.controller.status();
    f.nativePermission = false;
    expect(await f.controller.choose(true)).toEqual({enabled: false, promptHandled: false});
    expect(await f.create().status()).toEqual({enabled: false, promptHandled: false});
    f.nativePermission = true;
    expect(await f.controller.choose(true)).toEqual({enabled: true, promptHandled: true});
  });

  it('serializes simultaneous status reads and choices so stale initialization cannot re-open the card', async () => {
    const f = fixture();
    const results = await Promise.all([f.controller.status(), f.controller.choose(false), f.controller.status()]);
    expect(results[0]).toEqual({enabled: false, promptHandled: false});
    expect(results[2]).toEqual({enabled: false, promptHandled: true});
    expect(await f.create().status()).toEqual({enabled: false, promptHandled: true});
  });

  it('preserves an existing choice when native data permission is revoked', async () => {
    const f = fixture({consent: true});
    f.nativePermission = false;
    expect(await f.controller.status()).toEqual({enabled: false, promptHandled: true});
    f.clearAnalytics();
    expect(await f.create().status()).toEqual({enabled: false, promptHandled: true});
  });
});
