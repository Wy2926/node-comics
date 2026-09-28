import {useRef, useState} from 'react';
import {msg} from '../i18n/runtime';
import {analyticsAvailable, saveAnalyticsConsent} from './client';
import {refreshAnalyticsPreferences, useAnalyticsPreferences} from './consent';
import {removeAnalyticsPermission, requestAnalyticsPermission} from './permissions';

/** Settings and the bookshelf prompt use one permission and persistence workflow. */
export function useAnalyticsConsentActions() {
  const preferences = useAnalyticsPreferences();
  const available = analyticsAvailable();
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function choose(next: boolean) {
    if (locked.current || !available || !preferences.ready) return;
    locked.current = true;
    setPending(true);
    setError('');
    try {
      // Firefox must receive this request directly from the user's click handler.
      if (next && !await requestAnalyticsPermission()) {
        setError(msg('浏览器未允许使用情况分析，设置保持关闭。'));
        return;
      }
      const saved = await saveAnalyticsConsent(next);
      if (next && !saved) {
        setError(msg('浏览器未允许使用情况分析，设置保持关闭。'));
        return;
      }
      await refreshAnalyticsPreferences();
      if (!next) await removeAnalyticsPermission();
    } catch {
      setError(msg('设置未保存，请重试。'));
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return {...preferences, available, pending, error, choose};
}
