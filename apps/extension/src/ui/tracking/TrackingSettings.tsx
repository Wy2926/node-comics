import {useId, useRef, useState} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {trackingClient} from '../../tracking/client';
import {SettingRow} from '../components';
import {useTracking} from './useTracking';
import './tracking.css';

export function TrackingSettings() {
  const {view, error, busy, refresh, run} = useTracking(), disclosure = useId();
  const [authorizationEnabled, setAuthorizationEnabled] = useState<boolean>(), authorization = useRef(0), authorizing = useRef(false);
  async function connect() {
    if (!view || busy || authorizing.current) return;
    const attempt = ++authorization.current;
    authorizing.current = true;
    setAuthorizationEnabled(view.enabled);
    await run(() => trackingClient.connect());
    if (authorization.current === attempt) { authorization.current++; authorizing.current = false; setAuthorizationEnabled(undefined); }
  }
  function disconnect() {
    authorization.current++; authorizing.current = false; setAuthorizationEnabled(undefined);
    void run(() => trackingClient.disconnect(), true);
  }
  async function toggle() {
    if (!view) return;
    const enabled = !(authorizationEnabled ?? view.enabled), attempt = authorization.current;
    // The background pauses sends while OAuth is open; keep its intended state editable.
    if (authorizationEnabled !== undefined) setAuthorizationEnabled(enabled);
    const saved = await run(() => trackingClient.setEnabled(enabled), !enabled);
    if (!saved && authorization.current === attempt && authorizationEnabled !== undefined) setAuthorizationEnabled(authorizationEnabled);
  }
  const enabled = authorizationEnabled ?? view?.enabled ?? false;
  return <section className="settings-card nc-tracking">
    <h3><Icon name="book"/>{msg('阅读追踪')}</h3>
    {!view && !error && <p role="status">{msg('加载中…')}</p>}
    {view && <>
      {!view.configured && <div className="nc-tracking-note">
        <p>{view.redirectUrl ? msg('此构建尚未配置 AniList 授权。') : msg('请在浏览器插件中连接 AniList。')}</p>
        {view.redirectUrl && <><p>{msg('请配置 VITE_ANILIST_CLIENT_ID，并在自有 AniList 应用中注册以下回调地址后重新构建。')}</p><code>{view.redirectUrl}</code></>}
      </div>}
      <SettingRow title={view.account ? msg('{0} 已连接', {'0': view.account.name}) : msg('连接 AniList')}
        description={msg('授权仅保存在当前浏览器，不会上传至 NodeLane；不要求 NodeLane 登录。')}>
        <div className="nc-tracking-actions">
          <button className="button secondary" type="button" disabled={busy || authorizationEnabled !== undefined || !view.configured} onClick={() => void connect()}>
            {authorizationEnabled !== undefined ? msg('正在连接…') : view.account ? msg('重新连接') : msg('连接 AniList')}
          </button>
          {(view.account || authorizationEnabled !== undefined) && <button className="button secondary" type="button" onClick={disconnect}>{msg('断开连接')}</button>}
        </div>
      </SettingRow>
      {view.configured && view.redirectUrl && <details className="nc-tracking-note">
        <summary>{msg('AniList 回调地址')}</summary>
        <code>{view.redirectUrl}</code>
      </details>}
      <div className="setting-row">
        <div><b>{msg('自动同步已读章节')}</b><p id={disclosure}>{msg('开启后，已关联作品的完成章节会创建或更新 AniList 阅读中条目；记录是否公开由 AniList 设置决定。')}</p></div>
        <button className={`switch${enabled ? ' on' : ''}`} type="button" role="switch" aria-checked={enabled}
          aria-label={msg('自动同步已读章节')} aria-describedby={disclosure} disabled={(busy || authorizationEnabled !== undefined) && !enabled || !view.account || !view.configured}
          onClick={() => void toggle()}><i/></button>
      </div>
      <p className="nc-muted">{msg('首次启用不会补传历史。断开连接不删除 AniList 已有记录。')}</p>
    </>}
    {error && <p role="alert" className="nc-tracking-error">{error} <button className="button secondary small" type="button" disabled={busy} onClick={() => void refresh()}>{msg('重试')}</button></p>}
  </section>;
}
