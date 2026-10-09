import {useEffect, useRef, useState} from 'react';
import {ApiError, authError, errorText, request} from './api';
import {BillingDialog, useBillingResource} from './BillingShared';
import {Empty, href, label, number, Pagination, Table, time} from './ui';
import {audienceName, campaignDate, campaignEndpoint, campaignRules, campaignState, campaignStorageKey, campaignTiming, localInputDate, newCampaignDraft,
  type CampaignDraft, type CampaignOperation, type CampaignTimingDraft, type QuotaCampaign} from './campaignRules';
import './QuotaCampaigns.css';

type Page<T> = {items: T[]; total: number};
type Award = {owner_id: string; created_at: string; grant: {
  granted: number; used: number; reserved: number; available: number; expires_at: string | null;
}};
type Props = {onUnauthorized: (message: string) => void};
const validity = (days: number | null) => days == null ? '永久有效' : `到账后 ${number(days)} 天`;

function TimingFields({draft, onChange}: {draft: CampaignTimingDraft; onChange: (key: keyof CampaignTimingDraft, value: string) => void}) {
  return <>
    <label>额度有效天数<input type="number" min={1} max={36500} step={1} value={draft.validity_days} onChange={e => onChange('validity_days', e.target.value)} placeholder="留空永久有效"/><small className="muted">从每位用户实际到账时起算。</small></label>
    <label>停止发放时间<input type="datetime-local" step={1} value={draft.ends_at} onChange={e => onChange('ends_at', e.target.value)}/><small className="muted">留空持续发放；时间按本机时区填写。</small></label>
  </>;
}

function CampaignForm({copy, onClose, onSubmit}: {copy?: QuotaCampaign; onClose: () => void; onSubmit: (operation: CampaignOperation) => void}) {
  const [draft, setDraft] = useState(() => newCampaignDraft(copy));
  const [error, setError] = useState('');
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => {firstField.current?.focus();}, []);
  const field = <K extends keyof CampaignDraft>(key: K, value: CampaignDraft[K]) => setDraft(previous => ({...previous, [key]: value}));
  return <BillingDialog title={copy ? '复制为新活动' : '新建额度活动'} onClose={onClose}>
    <form className="campaign-form" onSubmit={event => {
      event.preventDefault(); setError('');
      try {
        const body = campaignRules(draft);
        onSubmit({id: `campaign-${crypto.randomUUID()}`, method: 'PUT', body,
          summary: `创建“${body.name}”：${audienceName[body.audience]}，每人 ${body.pages} 页${label(body.mode)}，${validity(body.validity_days)}。${body.starts_at ? time(body.starts_at) : '创建后'}起，${body.ends_at ? time(body.ends_at) + '停止发放' : '不限制发放结束时间'}。保存后为暂停状态。`});
      } catch (failure) {setError(errorText(failure));}
    }}>
      <div className="billing-form-grid">
        <label className="campaign-full">活动名称<input ref={firstField} required maxLength={100} value={draft.name} onChange={e => field('name', e.target.value)} placeholder="例如：新用户翻译额度"/></label>
        <label>翻译模式<select value={draft.mode} onChange={e => field('mode', e.target.value as CampaignDraft['mode'])}><option value="classic">常规翻译</option></select></label>
        <label>每人赠送页数<input type="number" required min={1} max={1000000} step={1} value={draft.pages} onChange={e => field('pages', e.target.value)}/></label>
        <label>适用用户<select value={draft.audience} onChange={e => field('audience', e.target.value as CampaignDraft['audience'])}>{Object.entries(audienceName).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select><small className="muted">新老用户以活动创建时间划分，与开始时间无关。</small></label>
        <label>开始发放时间<input type="datetime-local" value={draft.starts_at} onChange={e => field('starts_at', e.target.value)}/><small className="muted">留空表示启用后即可发放。</small></label>
        <TimingFields draft={draft} onChange={field}/>
      </div>
      <div className="campaign-impact"><strong>{copy ? '这是另一笔赠送活动' : '保存后核对规则，再启用发放'}</strong><p>每个活动每人领取一次。{copy && '复制后会重新划分新老用户，发放时间需重新设置。'}不同活动的额度可以叠加，已领过其他活动的用户也可能再次获赠。页数、模式和人群保存后固定；同一活动的期限可单独调整。</p></div>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="campaign-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary">保存为暂停活动</button></div>
    </form>
  </BillingDialog>;
}

function DurationForm({campaign, onClose, onSubmit}: {campaign: QuotaCampaign; onClose: () => void; onSubmit: (operation: CampaignOperation) => void}) {
  const [draft, setDraft] = useState<CampaignTimingDraft>({ends_at: localInputDate(campaign.ends_at), validity_days: campaign.validity_days == null ? '' : String(campaign.validity_days)});
  const [existing, setExisting] = useState(false), [note, setNote] = useState(''), [error, setError] = useState('');
  return <BillingDialog title="调整活动期限" onClose={onClose}>
    <form className="campaign-form" onSubmit={event => {
      event.preventDefault(); setError('');
      try {
        if (!note.trim()) throw Error('请填写调整原因。');
        const timing = campaignTiming(draft, campaignDate(campaign.starts_at).getTime());
        // Editing validity alone must not truncate an existing timestamp's precision.
        if (draft.ends_at === localInputDate(campaign.ends_at)) timing.ends_at = campaign.ends_at;
        onSubmit({id: campaign.id, method: 'PATCH', action: 'duration', body: {...timing, apply_to_existing: existing, note: note.trim(), expected_version: campaign.version},
          summary: `调整“${campaign.name}”：${validity(timing.validity_days)}，${timing.ends_at ? time(timing.ends_at) + '停止发放' : '持续发放'}。${existing ? '同步调整已到账额度，从原到账时间起算' : '仅后续发放采用新有效期'}。原因：${note.trim()}`});
      } catch (failure) {setError(errorText(failure));}
    }}>
      <div><h3>{campaign.name}</h3><p className="muted">{audienceName[campaign.audience]} · 每人 {number(campaign.pages)} 页{label(campaign.mode)} · {time(campaign.starts_at)}开始</p></div>
      <div className="billing-form-grid"><TimingFields draft={draft} onChange={(key, value) => setDraft(previous => ({...previous, [key]: value}))}/></div>
      <label className="campaign-existing"><input type="checkbox" checked={existing} onChange={event => setExisting(event.target.checked)}/>同步调整已到账额度的有效期</label>
      <div className="campaign-impact"><p>{existing ? `将按原到账时间重新计算本活动已发 ${number(campaign.awarded_users)} 笔额度的到期时间。缩短可能使额度立即到期，延长可能恢复尚未用完的额度。` : '新有效期仅用于后续发放，已有额度保留原到期时间。'}已用、预占和每人一次的领取记录保留。停止发放时间早于现在时，活动立即结束；仅修改停止时间不会撤回已发额度。</p></div>
      <label className="campaign-note">调整原因<textarea required maxLength={200} rows={2} value={note} onChange={event => setNote(event.target.value)}/></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="campaign-actions"><button className="secondary" type="button" onClick={onClose}>取消</button><button className="primary">保存期限调整</button></div>
    </form>
  </BillingDialog>;
}

function AwardsDialog({campaign, onClose, onUnauthorized}: Props & {campaign: QuotaCampaign; onClose: () => void}) {
  const [offset, setOffset] = useState(0);
  const {data, loading, error, reload} = useBillingResource<Page<Award>>(`${campaignEndpoint}/${encodeURIComponent(campaign.id)}/awards?offset=${offset}&limit=25`, onUnauthorized);
  return <BillingDialog title={`${campaign.name} · 发放记录`} onClose={onClose} className="campaign-awards">
    <div className="campaign-record-heading"><p className="muted">每人 {number(campaign.pages)} 页{label(campaign.mode)} · {validity(campaign.validity_days)}</p><button className="secondary" disabled={loading} onClick={() => void reload()}>{loading ? '正在刷新…' : '刷新记录'}</button></div>
    {error && <p className="error" role="alert">{error} {data && '当前记录可能已过时。'}请刷新重试。</p>}
    {!data ? <p className="loading" role="status">{loading ? '正在读取记录…' : '暂时无法读取记录。'}</p> : <div aria-busy={loading}>
      {!data.items.length ? <Empty>尚无发放记录</Empty> : <Table heads={['用户', '到账时间', '赠送 / 已用 / 预占 / 剩余', '额度到期']}>{data.items.map(award => <tr key={award.owner_id}>
        <td><a className="text-link" href={href('users', {q: award.owner_id})}>{award.owner_id}</a></td><td>{time(award.created_at)}</td>
        <td>{[award.grant.granted, award.grant.used, award.grant.reserved, award.grant.available].map(number).join(' / ')}</td><td>{award.grant.expires_at ? time(award.grant.expires_at) : '永久有效'}</td>
      </tr>)}</Table>}
      <Pagination total={data.total} count={data.items.length} offset={offset} next={offset + 25 < data.total ? offset + 25 : null} onPage={setOffset}/>
    </div>}
  </BillingDialog>;
}

export function QuotaCampaignsPage({onUnauthorized}: Props) {
  const [offset, setOffset] = useState(0);
  const {data, loading, error, reload} = useBillingResource<Page<QuotaCampaign>>(`${campaignEndpoint}?offset=${offset}&limit=25`, onUnauthorized);
  const [editor, setEditor] = useState<{copy?: QuotaCampaign}>();
  const [awards, setAwards] = useState<QuotaCampaign>();
  const [confirmation, setConfirmation] = useState<QuotaCampaign>();
  const [duration, setDuration] = useState<QuotaCampaign>();
  const [notice, setNotice] = useState(''), [actionError, setActionError] = useState(''), [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<CampaignOperation | undefined>(() => {
    try {return JSON.parse(sessionStorage.getItem(campaignStorageKey) || 'null') || undefined;} catch {return undefined;}
  });
  const lock = useRef(false);
  const blocked = loading || !!error || !!operation || busy || !data;
  useEffect(() => {document.title = '额度活动 · Node Comics 管理后台';}, []);
  async function execute(current: CampaignOperation) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setActionError(''); setNotice('');
    try {
      // Persist the original request before transmission, including its stable ID/version.
      sessionStorage.setItem(campaignStorageKey, JSON.stringify(current)); setOperation(current);
      setEditor(undefined); setConfirmation(undefined); setDuration(undefined);
      await request(`${campaignEndpoint}/${encodeURIComponent(current.id)}${current.action === 'duration' ? '/duration' : ''}`, {method: current.method,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(current.body)});
      sessionStorage.removeItem(campaignStorageKey); setOperation(undefined);
      setNotice(current.method === 'PUT' ? '活动创建已确认。新活动默认暂停，当前启停状态以刷新后的列表为准。' : current.action === 'duration' ? '期限调整已完成，领取记录已保留。当前规则以刷新后的列表为准。' : '操作已确认。当前状态以刷新后的列表为准，发放记录可刷新查看。');
      if (current.method === 'PUT' && offset) setOffset(0); else await reload();
    } catch (failure) {
      if (authError(failure)) {onUnauthorized(errorText(failure)); return;}
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        sessionStorage.removeItem(campaignStorageKey); setOperation(undefined);
        setActionError(failure.status === 409 ? '活动已被其他操作更新，或编号已被占用。已重新读取列表，请核对当前状态后再操作。' : errorText(failure));
        await reload();
      } else setActionError(errorText(failure));
    } finally {lock.current = false; setBusy(false);}
  }
  return <main id="main" tabIndex={-1} className="quota-campaigns">
    <div className="page-heading"><div><p className="eyebrow">QUOTA CAMPAIGNS</p><h1>额度活动</h1><p className="muted">配置自动赠送规则，查看到账人数与每位用户的发放记录。</p></div><div className="provider-actions">
      <button className="secondary" disabled={loading || busy} onClick={() => void reload()}>{loading ? '正在刷新…' : '刷新列表'}</button><button className="primary" disabled={blocked} onClick={() => {setActionError(''); setEditor({});}}>＋ 新建活动</button>
    </div></div>
    <p className="campaign-help">启用后自动发放给符合条件的用户；暂停或结束只停止后续发放，已到账额度保留。每个活动每人一次，恢复启用不会重复赠送。</p>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
    {operation && <section className="panel campaign-recovery" aria-label="待核实的活动操作"><h2>{busy ? '正在提交活动操作…' : '有一笔活动操作待核实'}</h2><p>{operation.summary}</p><p className="muted">原请求已保留。请核实这笔操作后再继续，重试不会重复创建活动或发放额度。</p><button className="primary" disabled={busy} onClick={() => void execute(operation)}>{busy ? '正在提交…' : '重试并核实原操作'}</button></section>}
    {actionError && <p className="error" role="alert">{actionError}</p>}
    {error && <p className="error" role="alert">{error} {data && '当前列表可能已过时，已暂停配置操作。'}请刷新重试。</p>}
    {!data ? <section className="panel"><p className="loading" role="status">{loading ? '正在读取活动…' : '暂时无法读取活动。'}</p></section> : <section className="panel list-panel" aria-label="额度活动列表" aria-busy={loading}>
      {!data.items.length ? <Empty>尚未创建额度活动</Empty> : <Table heads={['活动', '赠送规则', '适用用户', '发放时间', '状态', '已到账', '操作']}>{data.items.map(campaign => {
        const state = campaignState(campaign);
        const ended = !!campaign.ends_at && campaignDate(campaign.ends_at).getTime() <= Date.now();
        return <tr key={campaign.id}>
          <td className="campaign-name"><strong>{campaign.name}</strong><small>{campaign.id}</small><small>创建于 {time(campaign.created_at)}</small></td>
          <td><b>{number(campaign.pages)} 页{label(campaign.mode)}</b><small>{validity(campaign.validity_days)}</small></td>
          <td>{audienceName[campaign.audience]}{campaign.audience !== 'all' && <small>按活动创建时间划分</small>}</td>
          <td>{time(campaign.starts_at)}<small>至 {campaign.ends_at ? time(campaign.ends_at) : '不限期'}</small></td>
          <td><span className={`badge ${state.tone}`}>{state.text}</span></td><td><b>{number(campaign.awarded_users)} 人</b><small>累计 {number(campaign.awarded_users * campaign.pages)} 页</small></td>
          <td><div className="campaign-row-actions"><button className="text-link" disabled={loading} onClick={() => setAwards(campaign)}>发放记录</button><button className="text-link" disabled={blocked || (!campaign.enabled && ended)} onClick={() => setConfirmation(campaign)}>{campaign.enabled ? '暂停活动' : '启用发放'}</button><button className="text-link" disabled={blocked} onClick={() => setDuration(campaign)}>调整期限</button><button className="text-link" disabled={blocked} onClick={() => setEditor({copy: campaign})}>复制新活动</button></div></td>
        </tr>;
      })}</Table>}
      <Pagination total={data.total} count={data.items.length} offset={offset} next={offset + 25 < data.total ? offset + 25 : null} onPage={setOffset}/>
    </section>}
    <p className="footnote">活动名称用于额度记录，不会自动发布宣传。调整期限沿用原领取记录；复制新活动会单独赠送。</p>
    {editor && <CampaignForm copy={editor.copy} onClose={() => setEditor(undefined)} onSubmit={current => void execute(current)}/>}
    {awards && <AwardsDialog key={awards.id} campaign={awards} onUnauthorized={onUnauthorized} onClose={() => setAwards(undefined)}/>}
    {duration && <DurationForm campaign={duration} onClose={() => setDuration(undefined)} onSubmit={current => void execute(current)}/>}
    {confirmation && <BillingDialog title={confirmation.enabled ? '暂停额度活动' : '启用额度活动'} onClose={() => setConfirmation(undefined)}>
      <h3>{confirmation.name}</h3><p>{audienceName[confirmation.audience]} · 每人 {number(confirmation.pages)} 页{label(confirmation.mode)} · {validity(confirmation.validity_days)}</p>
      <p className="muted">{time(confirmation.starts_at)}起，{confirmation.ends_at ? time(confirmation.ends_at) + '停止发放' : '持续发放'}。</p>
      <div className="campaign-impact"><p>{confirmation.enabled ? '暂停后不再发放新的额度，已到账额度及在途任务结算保留。恢复后会补发给仍符合条件且未领取的用户。' : '启用后，在发放时间内自动赠送给符合条件的用户。已有用户分批到账，新用户注册时到账。本活动中已领过的用户不会重复领取；其他活动的额度可以叠加。'}</p></div>
      <div className="campaign-actions"><button className="secondary" onClick={() => setConfirmation(undefined)}>取消</button><button className="primary" disabled={blocked} onClick={() => void execute({id: confirmation.id, method: 'PATCH', body: {enabled: !confirmation.enabled, expected_version: confirmation.version}, summary: `${confirmation.enabled ? '暂停' : '启用'}“${confirmation.name}”：${audienceName[confirmation.audience]}，每人 ${confirmation.pages} 页${label(confirmation.mode)}，${validity(confirmation.validity_days)}。`})}>{confirmation.enabled ? '确认暂停' : '确认启用'}</button></div>
    </BillingDialog>}
  </main>;
}
