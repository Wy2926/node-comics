import {useId} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {AnalyticsDisclosure} from './AnalyticsDisclosure';
import {useAnalyticsConsentActions} from './useAnalyticsConsentActions';
import './prompt.css';

export function AnalyticsPrompt({active}: {active: boolean}) {
  const {ready, enabled, promptHandled, available, pending, error, choose} = useAnalyticsConsentActions();
  const title = useId();
  if (!active || !ready || !available || enabled || promptHandled) return null;

  return <section className="nc-analytics-prompt" aria-labelledby={title} data-analytics-prompt>
    <div className="nc-analytics-prompt-content">
      <h2 id={title}><Icon name="shield" size={20}/>{msg('帮助改进 NodeLane（可选）')}</h2>
      <AnalyticsDisclosure/>
      <p>{msg('不影响阅读和导入，之后可随时在设置中更改。')}</p>
    </div>
    <button className="icon-button" aria-label={msg('不发送并关闭提示')} disabled={pending} onClick={() => void choose(false)}><Icon name="close"/></button>
    <div className="nc-analytics-prompt-actions">
      <button className="button secondary small" disabled={pending} onClick={() => void choose(true)}>{msg('允许使用分析')}</button>
      <button className="button secondary small" disabled={pending} onClick={() => void choose(false)}>{msg('不发送')}</button>
    </div>
    {pending && <p className="nc-analytics-prompt-status" role="status">{msg('正在保存设置…')}</p>}
    {error && <p className="nc-analytics-prompt-error" role="alert">{error}</p>}
  </section>;
}
