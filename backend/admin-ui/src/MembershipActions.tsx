import {useRef, useState} from 'react';
import {ApiError, errorText, request} from './api';
import type {UserDetail} from './types';
import {time} from './ui';

type Operation = {key: string; path: string; body: Record<string, unknown>; summary: string; done?: boolean};
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function MembershipActions({user, onChanged}: {user: UserDetail; onChanged: () => void}) {
  const extendingGift = user.operator_membership?.active ?? false;
  // Keep an uncertain write's exact body and key across dialog close/reload.
  const storageKey = `nc-admin-benefit:${user.id}`;
  const [operation, setOperation] = useState<Operation | undefined>(() => {
    try {return JSON.parse(sessionStorage.getItem(storageKey) || 'null') || undefined;} catch {return undefined;}
  });
  const [kind, setKind] = useState('plus'), [days, setDays] = useState(30), [pages, setPages] = useState(30);
  const [monthlyPages, setMonthlyPages] = useState(300), [mode, setMode] = useState('redraw');
  const [starts, setStarts] = useState(''), [expires, setExpires] = useState(() => localDate(new Date(Date.now() + 30 * 86400000)));
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const save = (value: Operation | undefined) => {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey);
    setOperation(value);
  };
  async function submit() {
    if (lock.current || operation?.done) return;
    lock.current = true; setBusy(true); setError('');
    try {
      let current = operation;
      if (!current) {
        const plus = kind === 'plus';
        if (!note.trim()) throw Error('请填写赠送原因。');
        if (plus && (!Number.isInteger(days) || days < 1 || days > 3660)) throw Error('会员天数需为 1–3660 的整数。');
        if (!plus && (!Number.isInteger(pages) || pages < 1 || pages > 1000000)) throw Error('赠送页数需为 1–1000000 的整数。');
        if (plus && (!Number.isInteger(monthlyPages) || monthlyPages < 0 || monthlyPages > 1000000)) throw Error('每会员月重绘页数需为 0–1000000 的整数。');
        if (!plus && (!expires || new Date(expires).getTime() <= Math.max(Date.now(), starts ? new Date(starts).getTime() : 0))) throw Error('到期时间需晚于现在和生效时间。');
        current = {key: crypto.randomUUID(), path: `/v1/admin/users/${encodeURIComponent(user.id)}/${plus ? 'membership' : 'quota-grants'}`,
          body: plus ? {action: 'extend', days, ...(!extendingGift ? {monthly_pages: monthlyPages} : {}), note: note.trim()}
            : {mode, pages, ...(starts ? {starts_at: new Date(starts).toISOString()} : {}), expires_at: new Date(expires).toISOString(), note: note.trim()},
          summary: plus ? `赠送 PLUS ${days} 天${extendingGift ? '，从当前赠送到期时间延长，保留原重绘周期' : `，每会员月 ${monthlyPages} 页重绘`}`
            : `赠送${mode === 'classic' ? '常规翻译' : 'AI 重绘'} ${pages} 页，${starts ? time(starts) : '立即'}生效，${time(expires)}到期`};
        save(current);
      }
      await request(current.path, {method: 'POST', headers: {'Content-Type': 'application/json', 'Idempotency-Key': current.key}, body: JSON.stringify(current.body)});
      save({...current, done: true}); onChanged();
    } catch (e) {
      // Only a definite rejection permits changing the request. Ambiguous failures
      // retain the operation until the administrator recovers the same receipt.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) save(undefined);
      setError(errorText(e));
    } finally {lock.current = false; setBusy(false);}
  }
  return <section className="panel membership-actions" aria-labelledby="benefit-title">
    <h3 id="benefit-title">赠送 PLUS 或翻译额度</h3>
    <p className="muted">赠送由平台承担费用，记录操作人和备注。已有赠送 PLUS 续期保留原重绘月额度；Paddle 订阅与赠送独立生效，不改变扣款日期。</p>
    {operation ? <>
      <p>{operation.summary}</p><p className="muted">备注：{String(operation.body.note)}</p>
      <p role="status">{operation.done ? '赠送成功，权益已更新。' : busy ? '正在提交赠送，请稍候…' : '提交结果尚未确认，请恢复原操作，避免重复赠送。'}</p>
      {operation.done ? <button className="secondary" onClick={() => {save(undefined); setNote(''); setError('');}}>创建另一笔赠送</button>
        : <button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? '正在提交…' : '重试并核实原操作'}</button>}
    </> : <form onSubmit={event => {event.preventDefault(); void submit();}}>
      <fieldset disabled={busy} className="benefit-fields">
        <label>赠送类型<select aria-label="赠送类型" value={kind} onChange={e => setKind(e.target.value)}><option value="plus">PLUS 会员</option><option value="quota">翻译额度</option></select></label>
        {kind === 'plus' ? <>
          <label>会员天数<input type="number" min={1} max={3660} required value={days} onChange={e => setDays(Number(e.target.value))}/></label>
          {!extendingGift && <label>每会员月重绘页数<input type="number" min={0} max={1000000} required value={monthlyPages} onChange={e => setMonthlyPages(Number(e.target.value))}/></label>}
          <p className="panel-note">{extendingGift ? '从当前赠送到期时间延长。' : '立即生效，常规翻译不限量。'}天数按 24 小时计算；重绘仍按开通日期的会员月刷新。短期赠送请显式设置重绘页数。</p>
        </> : <>
          <label>翻译模式<select aria-label="翻译模式" value={mode} onChange={e => setMode(e.target.value)}><option value="redraw">AI 重绘</option><option value="classic">常规翻译</option></select></label>
          <label>赠送页数<input type="number" min={1} max={1000000} required value={pages} onChange={e => setPages(Number(e.target.value))}/></label>
          <label>生效时间（留空立即生效）<input type="datetime-local" value={starts} onChange={e => setStarts(e.target.value)}/></label>
          <label>到期时间<input type="datetime-local" required value={expires} onChange={e => setExpires(e.target.value)}/></label>
          <p className="panel-note">时间使用本机时区。普通用户获赠有效重绘页数后可临时使用重绘；额度赠送不增加队列容量。</p>
        </>}
        <label>赠送备注<input maxLength={200} required value={note} onChange={e => setNote(e.target.value)} placeholder="填写活动、补偿或测试原因"/></label>
        <button className="primary" disabled={!note.trim()}>{busy ? '正在提交…' : '确认赠送'}</button>
      </fieldset>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
