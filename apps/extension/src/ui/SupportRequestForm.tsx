import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Api, ApiError } from '../api';
import { msg } from '../i18n/runtime';
import { Icon } from '../icons';
import { API_BASE } from '../service';
import './comic-sites.css';

const anonymousApi = new Api(API_BASE);
type Kind = 'website' | 'plugin';
const storageKey = (kind: Kind) => `nc-support-request:${API_BASE}:${kind}`;
type Draft = { key: string; site_name: string; url: string; comment: string; contact: string; locked?: boolean; receipt?: string };
const emptyDraft = (): Draft => ({ key: crypto.randomUUID(), site_name: '', url: '', comment: '', contact: '' });
function readDraft(kind: Kind): Draft {
  try {
    const draft = JSON.parse(sessionStorage.getItem(storageKey(kind)) ?? 'null');
    if (draft && ['key', 'site_name', 'url', 'comment', 'contact'].every(key => typeof draft[key] === 'string')) return draft;
  } catch { /* Session storage is optional. */ }
  return emptyDraft();
}

export function SupportRequestForm({kind}: {kind: Kind}) {
  const [draft, setDraft] = useState(() => readDraft(kind)), [sending, setSending] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  useEffect(() => { try { sessionStorage.setItem(storageKey(kind), JSON.stringify(draft)); } catch { /* Keep the in-memory draft. */ } }, [draft, kind]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || draft.receipt) return;
    const payload = { kind, site_name: draft.site_name.trim(), url: draft.url.trim(), comment: draft.comment.trim(), contact: draft.contact.trim() };
    try {
      if (kind === 'website') {
        const url = new URL(payload.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) throw Error();
        url.search = ''; url.hash = ''; payload.url = url.href;
        if (!payload.site_name) throw Error();
      } else if (!payload.comment) { setError(msg('请填写反馈内容。')); return; }
    } catch { setError(msg('请填写网站名称和有效的 HTTP / HTTPS 地址。')); return; }
    inFlight.current = true; setSending(true); setError('');
    const pending = { ...draft, ...payload, locked: true };
    // Persist the exact request before dispatch, so a lost response can be replayed.
    try { sessionStorage.setItem(storageKey(kind), JSON.stringify(pending)); } catch { /* In-memory replay remains available. */ }
    setDraft(pending);
    try {
      const result = await anonymousApi.request<{ id: string }>('/v1/support-requests', {
        method: 'POST', headers: { 'Idempotency-Key': pending.key }, body: JSON.stringify(payload),
      });
      setDraft({ ...pending, receipt: result.id });
    } catch (failure) {
      const known = failure instanceof ApiError && failure.status >= 400 && failure.status < 500;
      if (known) setDraft({ ...pending, locked: false, key: crypto.randomUUID() });
      setError((failure as Error).message + (known ? '' : msg(' 可重试确认，同一份反馈不会重复保存。')));
    } finally { inFlight.current = false; setSending(false); }
  }
  return <div className="nc-support-form">
        {draft.receipt ? <div className="nc-site-request-success" role="status"><Icon name="check" size={30}/><h3>{msg('反馈已收到')}</h3><p>{kind === 'website' ? msg('申请已送达，我们会评估网站兼容性。') : msg('感谢你的反馈，我们会认真查看。')}</p><code>{draft.receipt}</code><button className="button secondary" onClick={() => { setDraft(emptyDraft()); setError(''); }}>{msg('继续提交')}</button></div> :
          <form onSubmit={event => void submit(event)} aria-busy={sending}>
            <fieldset disabled={sending || draft.locked}>
              {kind === 'website' && <><label className="field">{msg('网站名称')}<input required maxLength={100} value={draft.site_name} onChange={event => setDraft({ ...draft, site_name: event.target.value })}/></label>
              <label className="field">{msg('网站地址')}<input type="url" required maxLength={2048} placeholder="https://" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })}/></label></>}
              <label className="field">{kind === 'website' ? msg('补充说明（选填）') : msg('反馈内容')}<textarea required={kind === 'plugin'} rows={4} maxLength={1000} value={draft.comment} onChange={event => setDraft({ ...draft, comment: event.target.value })}/></label>
              <label className="field">{msg('联系方式（选填）')}<input maxLength={200} placeholder={msg('邮箱、QQ、微信或其他方式')} value={draft.contact} onChange={event => setDraft({ ...draft, contact: event.target.value })}/><span className="nc-site-contact-note">{msg('仅用于联系你，不会公开展示。')}</span></label>
            </fieldset>
            <p className="nc-site-request-note">{kind === 'website' ? msg('请提供公开页面地址，不要填写密码、登录凭据或私密链接。') : msg('请勿提交密码、登录凭据或私密图片。')}</p>
            {error && <p className="inline-error" role="alert">{error}</p>}
            <button className="button primary full" disabled={sending} type="submit"><Icon name={draft.locked ? 'refresh' : 'plus'} size={18}/>{sending ? msg('正在提交…') : draft.locked ? msg('重试确认反馈') : kind === 'website' ? msg('提交适配申请') : msg('提交反馈')}</button>
          </form>}
  </div>;
}
