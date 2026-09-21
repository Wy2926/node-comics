import {useRef, useState} from 'react';
import {ApiError, errorText, request} from './api';
import type {UserDetail} from './types';
import {time} from './ui';
import './CareOperations.css';

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
  const [monthlyPages, setMonthlyPages] = useState(''), [mode, setMode] = useState('redraw');
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
        const grant = kind === 'quota', expire = kind === 'expire', compensation = kind === 'compensation';
        if (!note.trim()) throw Error('请填写操作原因。');
        if (expire && !extendingGift) throw Error('当前没有可提前结束的运营会员。');
        if (plus && (!Number.isInteger(days) || days < 1 || days > 3660)) throw Error('会员天数需为 1–3660 的整数。');
        if ((grant || compensation) && (!Number.isInteger(pages) || pages < 1 || pages > 1000000)) throw Error('页数需为 1–1000000 的整数。');
        const customMonthlyPages = monthlyPages.trim() ? Number(monthlyPages) : undefined;
        if (plus && customMonthlyPages !== undefined && (!Number.isInteger(customMonthlyPages) || customMonthlyPages < 0 || customMonthlyPages > 1000000)) throw Error('每会员月重绘页数需为 0–1000000 的整数。');
        if (grant && (!expires || new Date(expires).getTime() <= Math.max(Date.now(), starts ? new Date(starts).getTime() : 0))) throw Error('到期时间需晚于现在和生效时间。');
        current = {key: crypto.randomUUID(), path: `/v1/admin/users/${encodeURIComponent(user.id)}/${plus || expire ? 'membership' : compensation ? 'quota-compensations' : 'quota-grants'}`,
          body: plus ? {action: 'extend', days, ...(!extendingGift && customMonthlyPages !== undefined ? {monthly_pages: customMonthlyPages} : {}), note: note.trim()}
            : expire ? {action: 'expire', note: note.trim()}
            : compensation ? {kind: mode === 'classic' ? 'classic_daily' : 'redraw_monthly', pages, note: note.trim()}
            : {mode, pages, ...(starts ? {starts_at: new Date(starts).toISOString()} : {}), expires_at: new Date(expires).toISOString(), note: note.trim()},
          summary: plus ? `赠送 PLUS ${days} 天${extendingGift ? '，从当前赠送到期时间延长，保留原重绘周期' : customMonthlyPages === undefined ? '，新会员段采用服务端受理时的系统默认月重绘页数' : `，每会员月 ${customMonthlyPages} 页重绘`}`
            : expire ? '立即结束运营赠送会员；已有预占任务继续按原额度结算，付费订阅与限时赠送额度独立生效'
            : compensation ? `为当前${mode === 'classic' ? '常规每日' : '重绘每月'}额度补偿 ${pages} 页，沿用本期到期时间`
            : `赠送${mode === 'classic' ? '常规翻译' : 'AI 重绘'} ${pages} 页，${starts ? time(new Date(starts).toISOString()) : '立即'}生效，${time(new Date(expires).toISOString())}到期`};
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
  const redraw = user.entitlements.modes.redraw;
  return <section className="panel membership-actions care-membership" aria-labelledby="benefit-title">
    <div className="care-section-heading"><div><h3 id="benefit-title">会员与额度处置</h3><p className="care-subtitle">为 {user.name} 调整运营权益，每笔操作保留处理人与原因。</p></div><span className="care-inline-tag">运营处置</span></div>
    <div className="care-entitlement-context" aria-label="当前权益上下文"><div><span className="care-label">当前身份</span><strong>{user.entitlements.plan === 'plus' ? 'PLUS' : '普通用户'}</strong><small>{user.entitlements.modes.classic.unlimited ? '常规翻译不限量' : `常规可用 ${user.entitlements.modes.classic.quota?.available ?? 0} 页`}</small></div><div><span className="care-label">运营会员</span><strong>{extendingGift ? '生效中' : '未生效'}</strong><small>{extendingGift ? `到期 ${time(user.operator_membership?.expires_at)}` : '可新开通运营会员'}</small></div><div><span className="care-label">当前重绘额度</span><strong>{redraw.allowed ? `${redraw.quota?.available ?? 0} 页可用` : '暂无使用权益'}</strong><small>在途预占 {redraw.quota?.reserved ?? 0} 页</small></div></div>
    {operation ? <div className={`care-operation-receipt ${operation.done ? 'care-operation-complete' : ''}`}>
      <div className="care-section-heading"><h4>{operation.done ? '权益操作已完成' : '恢复原权益操作'}</h4><span className={`care-status ${operation.done ? 'care-status-resolved' : 'care-status-reviewing'}`}>{operation.done ? '已完成' : '待确认'}</span></div>
      <p>{operation.summary}</p><div className="care-receipt-note"><span className="care-label">操作备注</span><p>{String(operation.body.note)}</p></div>
      <p className="care-subtitle" role="status">{operation.done ? '操作成功，权益已更新。' : busy ? '正在提交操作，请稍候…' : '提交结果尚未确认，请恢复原操作，避免重复发放。'}</p>
      <div className="care-action-footer">{operation.done ? <button className="secondary" onClick={() => {save(undefined); setNote(''); setError('');}}>创建另一笔操作</button>
        : <button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? '正在提交…' : '重试并核实原操作'}</button>}</div>
    </div> : <form className="care-form" onSubmit={event => {event.preventDefault(); void submit();}}>
      <fieldset disabled={busy}>
        <div className="care-operation-choice"><label>操作类型<select aria-label="操作类型" value={kind} onChange={e => setKind(e.target.value)}><option value="plus">赠送 PLUS 会员</option><option value="quota">赠送翻译额度</option><option value="compensation">当前周期额度补偿</option><option value="expire" disabled={!extendingGift}>提前结束运营会员</option></select></label><p className="care-subtitle">{({plus: extendingGift ? '延长当前运营会员，保留原重绘周期与月额度。' : '开通运营会员，设置有效天数与每月重绘额度。', quota: '按指定起止时间，独立赠送常规或重绘页数。', compensation: '补足当前周期页数，到期时间保持不变。', expire: '立即终止当前运营会员段。'} as Record<string, string>)[kind]}</p></div>
        <div className="care-fields-grid">
        {kind === 'plus' ? <>
          <label>会员天数<input type="number" min={1} max={3660} required value={days} onChange={e => setDays(Number(e.target.value))}/></label>
          {!extendingGift && <label>每会员月重绘页数（可选）<input type="number" min={0} max={1000000} value={monthlyPages} onChange={e => setMonthlyPages(e.target.value)} placeholder="留空采用系统默认"/></label>}
        </> : kind === 'expire' ? null : <>
          <label>翻译模式<select aria-label="翻译模式" value={mode} onChange={e => setMode(e.target.value)}><option value="redraw">AI 重绘</option><option value="classic">常规翻译</option></select></label>
          <label>{kind === 'compensation' ? '补偿页数' : '赠送页数'}<input type="number" min={1} max={1000000} required value={pages} onChange={e => setPages(Number(e.target.value))}/></label>
          {kind !== 'compensation' && <>
          <label>生效时间（留空立即生效）<input type="datetime-local" value={starts} onChange={e => setStarts(e.target.value)}/></label>
          <label>到期时间<input type="datetime-local" required value={expires} onChange={e => setExpires(e.target.value)}/></label>
          </>}
        </>}
        </div>
        <div className={`care-impact ${kind === 'expire' ? 'care-impact-danger' : ''}`}><span className="care-label">{kind === 'expire' ? '提前结束的影响' : '操作影响'}</span><p>{kind === 'plus' ? <>{extendingGift ? '从当前赠送到期时间延长，保留原月额度。' : '立即生效，常规翻译不限量；重绘页数留空采用系统默认。'}天数按 24 小时计算，重绘按开通日期的会员月刷新。短期赠送请显式设置重绘页数。</> : kind === 'expire' ? '确认后立即结束当前运营会员。已有预占任务保留原额度结算；此操作不会取消付费订阅，也不会撤回独立的限时赠送额度。' : kind === 'compensation' ? '补偿沿用当前额度桶的到期时间。重绘需有效 PLUS，优先补偿运营会员本期额度；仅有付费订阅时补偿最早到期的有效订阅桶。常规不限量用户的每日补偿仅在普通权益下使用。' : '时间使用本机时区。普通用户获赠有效重绘页数后可临时使用重绘；额度赠送不增加翻译速率。'}</p></div>
        <label>操作备注<textarea maxLength={200} rows={2} required value={note} onChange={e => setNote(e.target.value)} placeholder="填写赠送、补偿或提前结束原因"/></label>
        <div className="care-action-footer"><small>原因必填 · {note.length} / 200</small><button className={kind === 'expire' ? 'care-danger-button' : 'primary'} disabled={!note.trim()}>{busy ? '正在提交…' : kind === 'expire' ? '确认提前结束' : kind === 'compensation' ? '确认补偿' : '确认赠送'}</button></div>
      </fieldset>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
