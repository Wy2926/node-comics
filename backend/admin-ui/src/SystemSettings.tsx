import {useCallback, useEffect, useRef, useState} from 'react';
import {ApiError, authError, errorText, request} from './api';
import {time} from './ui';

const fields = [
  {key: 'upload_user_concurrency', group: 'upload', title: '单用户同时上传数', unit: '个', min: 1, max: 32, integer: true,
    help: '每位用户最多同时进行的图片上传。'},
  {key: 'upload_global_concurrency', group: 'upload', title: '全站同时上传数', unit: '个', min: 1, max: 128, integer: true,
    help: '全站同时进行的图片上传总上限，应不小于单用户上限。'},
  {key: 'upload_idle_timeout_seconds', group: 'upload', title: '上传空闲超时', unit: '秒', min: 0.1, max: 120, integer: false,
    help: '连续未收到图片数据超过此时间，结束本次上传。'},
  {key: 'upload_body_timeout_seconds', group: 'upload', title: '单次上传最长时间', unit: '秒', min: 0.1, max: 900, integer: false,
    help: '接收一张图片的总时限，应不小于空闲超时。'},
  {key: 'upload_ingress_lease_seconds', group: 'upload', title: '上传占位有效期', unit: '秒', min: 15, max: 300, integer: true,
    help: '正常上传会续期；处理进程中断后，占位到期可重新使用。'},
  {key: 'feedback_requests_per_minute', group: 'feedback', title: '每用户反馈持续速率', unit: '条 / 分钟', min: 1, max: 1000, integer: true,
    help: '限制持续新增反馈的速度；发送机会按此速率恢复。'},
  {key: 'feedback_request_burst', group: 'feedback', title: '每用户反馈突发上限', unit: '条', min: 1, max: 100, integer: true,
    help: '每位用户短时间内可连续提交的新反馈数量。'},
  {key: 'feedback_receipts_per_day', group: 'feedback', title: '每用户每日新反馈上限', unit: '条 / 天', min: 1, max: 10000, integer: true,
    help: '按 UTC 自然日计算。重试已提交的同一条反馈不重复计数。'},
] as const;
type SettingKey = typeof fields[number]['key'];
type Values = Record<SettingKey, number>;
type Draft = Record<SettingKey, string>;
type Snapshot = {version: number; values: Values; updated_at: string | null; updated_by: string | null};
type FieldErrors = Partial<Record<SettingKey, string>>;
const endpoint = '/v1/admin/system-settings';
const toDraft = (values: Values) => Object.fromEntries(fields.map(field => [field.key, String(values[field.key])])) as Draft;
const changed = (draft: Draft, values: Values, key: SettingKey) => draft[key].trim() === '' || Number(draft[key]) !== values[key];

function validate(draft: Draft) {
  const errors: FieldErrors = {};
  const values = {} as Values;
  for (const field of fields) {
    const value = Number(draft[field.key]);
    if (!draft[field.key].trim() || !Number.isFinite(value) || value < field.min || value > field.max ||
        (field.integer && !Number.isInteger(value))) {
      errors[field.key] = `请输入 ${field.min}–${field.max} 范围内的${field.integer ? '整数' : '数值'}。`;
    }
    values[field.key] = value;
  }
  if (!errors.upload_user_concurrency && !errors.upload_global_concurrency && values.upload_user_concurrency > values.upload_global_concurrency) {
    errors.upload_user_concurrency = errors.upload_global_concurrency = '单用户同时上传数不能超过全站同时上传数。';
  }
  if (!errors.upload_idle_timeout_seconds && !errors.upload_body_timeout_seconds && values.upload_idle_timeout_seconds > values.upload_body_timeout_seconds) {
    errors.upload_idle_timeout_seconds = errors.upload_body_timeout_seconds = '上传空闲超时不能超过单次上传最长时间。';
  }
  return {values, errors};
}

export function SystemSettingsPage({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState<Draft>();
  const [operation, setOperation] = useState<'loading' | 'saving'>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const current = useRef({snapshot, draft});
  current.current = {snapshot, draft};
  const busy = !!operation;
  const dirty = !!(snapshot && draft && fields.some(field => changed(draft, snapshot.values, field.key)));
  const validation = draft && validate(draft);
  const invalid = !!validation && Object.keys(validation.errors).length > 0;

  const reload = useCallback(async (keepEdits = true) => {
    const previous = current.current;
    const controller = new AbortController();
    controllerRef.current?.abort(); controllerRef.current = controller;
    setOperation('loading'); setError(''); setNotice('');
    try {
      const latest = await request<Snapshot>(endpoint, {signal: controller.signal});
      if (controller.signal.aborted) return;
      const merged = toDraft(latest.values);
      let preserved = false;
      if (keepEdits && previous.snapshot && previous.draft) {
        for (const field of fields) {
          if (changed(previous.draft, previous.snapshot.values, field.key)) {
            merged[field.key] = previous.draft[field.key]; preserved = true;
          }
        }
      }
      setSnapshot(latest); setDraft(merged); setConflict(false);
      if (preserved) setNotice('已读取最新设置，并保留你的修改。请核对各项当前值后保存。');
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (authError(failure)) onUnauthorized(errorText(failure)); else setError(errorText(failure));
    } finally {
      if (controllerRef.current === controller) {controllerRef.current = undefined; setOperation(undefined);}
    }
  }, [onUnauthorized]);

  useEffect(() => {
    document.title = '系统设置 · Node Comics 管理后台';
    void reload(false);
    return () => {controllerRef.current?.abort(); controllerRef.current = undefined;};
  }, [reload]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  async function save() {
    if (busy || !snapshot || !draft || !dirty || invalid || conflict || !validation) return;
    const controller = new AbortController(); controllerRef.current = controller;
    setOperation('saving'); setError(''); setNotice('');
    try {
      const result = await request<Snapshot>(endpoint, {method: 'PUT', signal: controller.signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({expected_version: snapshot.version, values: validation.values})});
      if (controller.signal.aborted) return;
      setSnapshot(result); setDraft(toDraft(result.values)); setConflict(false);
      setNotice(`系统设置已保存，版本 ${result.version}。后续新请求将使用新设置。`);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (authError(failure)) onUnauthorized(errorText(failure));
      else if (failure instanceof ApiError && failure.status === 409 && failure.code === 'SYSTEM_SETTINGS_CONFLICT') {
        setConflict(true);
      } else setError(errorText(failure));
    } finally {
      if (controllerRef.current === controller) {controllerRef.current = undefined; setOperation(undefined);}
    }
  }

  return <main id="main" tabIndex={-1} className="system-settings">
    <div className="page-heading"><div><p className="eyebrow">SYSTEM SETTINGS</p><h1>系统设置</h1>
      <p className="muted">统一管理上传与反馈的服务保护设置。</p></div>
      <button className="secondary" disabled={busy} onClick={() => void reload()}>{operation === 'loading' ? '正在读取…' : '↻ 读取最新设置'}</button>
    </div>
    <div className="sync-line"><span role="status">{operation === 'saving' ? '正在保存设置…' : operation === 'loading' ? '正在读取系统设置…' :
      snapshot ? `版本 ${snapshot.version} · ${dirty ? '有未保存的更改' : '与已保存设置一致'}` : '尚未读取设置'}</span>
      <span>{snapshot?.updated_at ? `最后保存 ${time(snapshot.updated_at)}` : '保存后对新请求生效'}</span></div>
    {error && <div className="error" role="alert">{error}{draft && ' 你的输入已保留。'}</div>}
    {conflict && <div className="error settings-conflict" role="alert"><div><strong>设置已被其他管理员更新</strong>
      <p>你的输入已保留。请先读取最新设置，核对后再次保存。</p></div>
      <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>读取最新设置，保留我的修改</button></div>}
    {notice && <p className="success settings-notice" role="status">{notice}</p>}
    {!snapshot || !draft ? <section className="panel settings-loading" aria-busy={busy}>
      <p role="status">{busy ? '正在读取系统设置…' : '暂时无法读取设置，请点击“读取最新设置”重试。'}</p>
    </section> : <form className="settings-form" noValidate onSubmit={event => {event.preventDefault(); void save();}}>
      <fieldset disabled={busy} className="config-body">
        {(['upload', 'feedback'] as const).map(group => <section className="panel settings-panel" key={group} aria-labelledby={`settings-${group}`}>
          <div className="settings-section-heading"><span className="settings-section-icon" aria-hidden="true">{group === 'upload' ? '↥' : '≡'}</span>
            <div><h2 id={`settings-${group}`}>{group === 'upload' ? '上传保护' : '反馈保护'}</h2>
              <p className="muted">{group === 'upload' ? '控制上传连接数量与等待时间，保持服务可用。' : '限制重复新增反馈，保留用户正常反馈与重试的空间。'}</p></div></div>
          <div className="settings-fields">{fields.filter(field => field.group === group).map(field => {
            const fieldError = validation?.errors[field.key];
            const isChanged = changed(draft, snapshot.values, field.key);
            return <div className={`settings-field${isChanged ? ' is-changed' : ''}`} key={field.key}>
              <label htmlFor={field.key}>{field.title}{isChanged && <span className="settings-dirty-mark" aria-hidden="true">未保存</span>}</label>
              <div className="settings-number"><input id={field.key} name={field.key} type="number" required
                min={field.min} max={field.max} step={field.integer ? 1 : 'any'} value={draft[field.key]}
                aria-invalid={!!fieldError} aria-describedby={`${field.key}-help${fieldError ? ` ${field.key}-error` : ''}`}
                onChange={event => {setDraft({...draft, [field.key]: event.target.value}); setNotice('');}}/>
                <span>{field.unit}</span></div>
              <p className="muted" id={`${field.key}-help`}>{field.help}<br/>{field.min}–{field.max} {field.unit}{field.integer ? ' · 整数' : ''}</p>
              {fieldError && <p className="settings-field-error" id={`${field.key}-error`}>{fieldError}</p>}
              {isChanged && <p className="settings-current-value">当前已保存：{snapshot.values[field.key]} {field.unit}</p>}
            </div>;
          })}</div>
          <p className="settings-section-note">{group === 'upload' ? '保存对新接纳的上传生效；已接纳的上传保持原有超时设置。' :
            '修改设置不会清零已经使用的反馈预算，也不会改变用户的翻译页数额度。'}</p>
        </section>)}
      </fieldset>
      <div className="panel settings-save-bar"><div><strong>{conflict ? '请先读取最新设置' : dirty ? '有未保存的更改' : '设置已同步'}</strong>
        <p className="muted">{invalid ? '请修正上方标出的数值后保存。' : dirty ? '核对修改后保存，离开此页前请保存更改。' : '调整上方数值后可保存；无需重启服务。'}</p></div>
        <button className="primary" disabled={busy || !dirty || invalid || conflict}>{operation === 'saving' ? '正在保存…' : '保存系统设置'}</button></div>
    </form>}
  </main>;
}
