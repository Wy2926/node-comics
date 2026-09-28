import {useId} from 'react';
import {msg} from '../i18n/runtime';
import {AnalyticsDisclosure} from './AnalyticsDisclosure';
import {useAnalyticsConsentActions} from './useAnalyticsConsentActions';
import '../ui/auto-translate-tabs.css';

export function AnalyticsConsent() {
  const {enabled, ready, available, pending, error, choose} = useAnalyticsConsentActions();
  const hint = useId();
  return <div className="nc-auto-tabs">
    <div className="nc-auto-tabs-row">
      <div><b>{msg('帮助改进 NodeLane')}</b><AnalyticsDisclosure id={hint}/></div>
      <button className={'switch ' + (enabled ? 'on' : '')} role="switch" aria-label={msg('帮助改进 NodeLane')} aria-checked={enabled} aria-describedby={hint} disabled={!available || !ready || pending} onClick={() => void choose(!enabled)}><i/></button>
    </div>
    {!available && <p>{msg('请在浏览器插件中管理使用情况分析。')}</p>}
    {pending && <p role="status">{enabled ? msg('正在关闭…') : msg('正在开启…')}</p>}
    {error && <p className="nc-auto-tabs-error" role="alert">{error}</p>}
  </div>;
}
