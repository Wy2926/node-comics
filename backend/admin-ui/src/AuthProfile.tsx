import {useEffect, useRef, useState} from 'react';
import {authError, errorText, request} from './api';
import type {AuthProfile as Profile} from './types';
import {Button, time} from './ui';

export function AuthProfile({userId, profile, onUnauthorized}: {
  userId: string; profile: Profile; onUnauthorized: (message: string) => void;
}) {
  const [current, setCurrent] = useState(profile);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {setCurrent(previous => (profile.attempted_at || '') < (previous.attempted_at || '') ? previous : profile);}, [profile]);
  useEffect(() => () => controller.current?.abort(), []);
  async function refresh() {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active;
    setBusy(true); setError('');
    try {
      const result = await request<Profile>(`/v1/admin/users/${encodeURIComponent(userId)}/auth-profile/refresh`,
        {method: 'POST', signal: active.signal});
      if (!active.signal.aborted) setCurrent(result);
    } catch (failure) {
      if (active.signal.aborted) return;
      if (authError(failure)) onUnauthorized(errorText(failure)); else setError(errorText(failure));
    } finally {
      if (!active.signal.aborted) {setBusy(false); controller.current = undefined;}
    }
  }
  const status = !current.supported ? '此用户未关联当前 Auth。'
    : !current.configured ? '后端尚未配置 Auth 查询凭据。'
    : current.pending ? '已安排后台同步；可刷新用户查看最新结果。'
    : '资料变更或登录 Auth 后自动同步；本站昵称、角色与权益保持独立。';
  const empty = current.synced_at ? '未设置' : '尚未同步';
  return <section className="panel auth-profile" aria-label="Auth 信息">
    <div className="care-section-heading"><div><h3>Auth 信息</h3><p className="care-subtitle">来自身份服务，仅管理员可见</p></div>
      <Button type="button" className="secondary" disabled={busy || !current.configured || !current.supported}
        onClick={() => void refresh()}>{busy ? '正在同步 Auth…' : '刷新 Auth 信息'}</Button></div>
    <p className="muted" role="status">{status}</p>
    {(error || current.error) && <p className="error" role="alert">{error || current.error}。{current.synced_at ? '当前展示上次同步资料，可能已过时。' : '尚无已同步资料。'}</p>}
    <dl className="detail-meta">
      <dt>邮箱</dt><dd>{current.email || empty}</dd><dt>Auth 用户名</dt><dd>{current.username || empty}</dd>
      <dt>Auth 昵称</dt><dd>{current.name || empty}</dd><dt>手机号</dt><dd>{current.phone || empty}</dd>
      <dt>Auth 账户状态</dt><dd>{current.deleted ? '已删除' : current.suspended == null ? '未知' : current.suspended ? '已停用' : '正常'}</dd>
      <dt>Auth 注册时间</dt><dd>{time(current.auth_created_at)}</dd>
      <dt>最近登录 Auth</dt><dd>{time(current.last_sign_in_at)}</dd>
      <dt>最近成功同步</dt><dd>{time(current.synced_at)}</dd><dt>最近尝试同步</dt><dd>{time(current.attempted_at)}</dd>
      <dt>Auth 用户编号</dt><dd><code>{current.auth_user_id || '未关联'}</code></dd>
    </dl><p className="muted">最近登录是身份服务记录的登录时间，不是本站访问或令牌续期时间。</p>
  </section>;
}
