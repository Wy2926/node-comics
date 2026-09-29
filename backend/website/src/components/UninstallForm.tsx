import {useEffect, useRef, useState, type FormEvent} from 'react';
import {reasonIds, uninstallCopy, type Reason} from '../i18n/uninstall';
import type {Locale} from '../i18n';
import '../styles/uninstall.css';

const storageKey = 'nc-uninstall-feedback';
type Draft = {reason: Reason | ''; comment: string; key?: string; payload?: string; receipt?: string};
const empty: Draft = {reason: '', comment: ''};
function save(draft: Draft) {
  try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* In-memory retry still works. */ }
}

export default function UninstallForm({locale}: {locale: Locale}) {
  const t = uninstallCopy[locale];
  const [draft, setDraft] = useState<Draft>(empty);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [skipped, setSkipped] = useState(false), [error, setError] = useState('');
  const sending = useRef(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && (saved.reason === '' || reasonIds.includes(saved.reason)) && typeof saved.comment === 'string' && saved.comment.length <= 800
        && [saved.key, saved.payload, saved.receipt].every(value => value === undefined || typeof value === 'string')
        && Boolean(saved.key) === Boolean(saved.payload)) setDraft(saved);
    } catch { /* Storage is optional. */ }
    setReady(true);
  }, []);
  function edit(next: Draft) { setDraft(next); save(next); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || draft.receipt || !draft.reason) return;
    sending.current = true; setBusy(true); setError('');
    // Keep the exact body across language switches, reloads and unknown responses.
    const pending = {...draft, key: draft.key || crypto.randomUUID(), payload: draft.payload || JSON.stringify({
      kind: 'uninstall', comment: `${uninstallCopy['zh-CN'].reasons[draft.reason]}${draft.comment.trim() ? '\n\n' + draft.comment.trim() : ''}`,
    })};
    edit(pending);
    try {
      const response = await fetch('/v1/support-requests', {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: {'Content-Type': 'application/json', 'Idempotency-Key': pending.key},
        body: pending.payload, signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          edit({...draft, key: undefined, payload: undefined});
          setError(response.status === 429 ? t.limited : t.invalid);
          return;
        }
        throw Error('Unconfirmed response');
      }
      const result = await response.json();
      if (typeof result.id !== 'string' || !result.id) throw Error('Invalid receipt');
      edit({...pending, receipt: result.id});
    } catch { setError(t.error); }
    finally { sending.current = false; setBusy(false); }
  }
  return <div className="uninstall-card">
    {draft.receipt ? <div role="status"><h2>{t.success}</h2><p>{t.thanks}</p></div> : skipped ? <p role="status">{t.skipped}</p> : <>
      <form onSubmit={event => void submit(event)} aria-busy={busy}>
        <fieldset disabled={!ready || busy || !!draft.payload}>
          <legend>{t.reason}</legend>
          <div className="uninstall-reasons">{reasonIds.map(reason => <label key={reason}>
            <input type="radio" name="reason" value={reason} required checked={draft.reason === reason} onChange={() => edit({...draft, reason})}/><span>{t.reasons[reason]}</span>
          </label>)}</div>
          <label className="uninstall-comment">{t.comment}<textarea rows={3} maxLength={800} value={draft.comment} onChange={event => edit({...draft, comment: event.target.value})}/></label>
        </fieldset>
        <p className="uninstall-note">{t.privacy}</p>
        {error && <p className="status-panel error" role="alert">{error}</p>}
        <div className="uninstall-actions"><button className="button" type="submit" disabled={!ready || busy}>{busy ? t.sending : draft.payload ? t.retry : t.submit}</button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => {
            setSkipped(true);
            try { sessionStorage.removeItem(storageKey); } catch { /* No draft to clear. */ }
          }}>{t.skip}</button></div>
      </form>
      <noscript><p>{t.noScript}</p></noscript>
    </>}
  </div>;
}
