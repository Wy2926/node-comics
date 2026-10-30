import {useCallback, useEffect, useRef, useState} from 'react';
import {ApiError, authError, errorText, request} from './api';
import {time} from './ui';
import {changed, mergeDraft, normalizePrompt, numericFields, promptFields, promptLength, promptMaxLength, settingKeys, toDraft, validate,
  type Draft, type Snapshot} from './systemSettingsConfig';

const endpoint = '/v1/admin/system-settings';

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
  const dirty = !!(snapshot && draft && settingKeys.some(key => changed(draft, snapshot.values, key)));
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
      const {draft: merged, preserved} = mergeDraft(latest.values,
        keepEdits && previous.snapshot && previous.draft ? {values: previous.snapshot.values, draft: previous.draft} : undefined);
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
      setNotice(`系统设置已保存，版本 ${result.version}。生效范围见各项说明；已受理翻译仍使用原提示词。`);
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
      <p className="muted">管理译图保留期限、漫画翻译提示词、默认额度及匿名体验、翻译、上传和反馈保护规则。</p></div>
      <button className="secondary" disabled={busy} onClick={() => void reload()}>{operation === 'loading' ? '正在读取…' : '↻ 读取最新设置'}</button>
    </div>
    <div className="sync-line"><span role="status">{operation === 'saving' ? '正在保存设置…' : operation === 'loading' ? '正在读取系统设置…' :
      snapshot ? `版本 ${snapshot.version} · ${dirty ? '有未保存的更改' : '与已保存设置一致'}` : '尚未读取设置'}</span>
      <span>{snapshot?.updated_at ? `最后保存 ${time(snapshot.updated_at)}` : '各项生效范围见下方说明'}</span></div>
    {error && <div className="error" role="alert">{error}{draft && ' 你的输入已保留。'}</div>}
    {conflict && <div className="error settings-conflict" role="alert"><div><strong>设置已被其他管理员更新</strong>
      <p>你的输入已保留。请先读取最新设置，核对后再次保存。</p></div>
      <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>读取最新设置，保留我的修改</button></div>}
    {notice && <p className="success settings-notice" role="status">{notice}</p>}
    {!snapshot || !draft ? <section className="panel settings-loading" aria-busy={busy}>
      <p role="status">{busy ? '正在读取系统设置…' : '暂时无法读取设置，请点击“读取最新设置”重试。'}</p>
    </section> : <form className="settings-form" noValidate onSubmit={event => {event.preventDefault(); void save();}}>
      <fieldset disabled={busy} className="config-body">
        <section className="panel settings-panel" aria-labelledby="settings-prompts">
          <div className="settings-section-heading"><span className="settings-section-icon" aria-hidden="true">≡</span>
            <div><h2 id="settings-prompts">LLM 翻译提示词</h2>
              <p className="muted">编辑翻译语义与风格要求。推荐提示词由服务端提供；恢复推荐后仍需保存。</p></div></div>
          <p className="settings-prompt-contract">目标语言、JSON 输出结构、文本编号对应关系及“源文本只作为待翻译数据”的安全约束由服务端固定追加，不在这里编辑。无需填写变量或输出模板。</p>
          <div className="settings-prompt-fields">{promptFields.map(field => {
            const fieldError = validation?.errors[field.key];
            const isChanged = changed(draft, snapshot.values, field.key);
            return <div className={`settings-field${isChanged ? ' is-changed' : ''}`} key={field.key}>
              <label htmlFor={field.key}>{field.title}{isChanged && <span className="settings-dirty-mark" aria-hidden="true">未保存</span>}</label>
              <textarea id={field.key} name={field.key} className="settings-prompt" required rows={12}
                value={draft[field.key]} aria-invalid={!!fieldError}
                aria-describedby={`${field.key}-help ${field.key}-effect ${field.key}-count${fieldError ? ` ${field.key}-error` : ''}`}
                onChange={event => {setDraft({...draft, [field.key]: event.target.value}); setNotice('');}}/>
              <div className="settings-prompt-actions"><span className="muted" id={`${field.key}-count`}>{promptLength(draft[field.key])} / {promptMaxLength} 字符</span>
                <button type="button" className="secondary" disabled={normalizePrompt(draft[field.key]) === snapshot.prompt_defaults[field.key]} onClick={() => {
                  const recommended = snapshot.prompt_defaults[field.key];
                  setDraft({...draft, [field.key]: recommended});
                  setNotice(recommended === snapshot.values[field.key] ? `已恢复“${field.title}”的已保存推荐内容。` :
                    `已将“${field.title}”恢复为推荐内容，请保存后生效。`);
                }}>恢复推荐提示词</button></div>
              <p className="muted" id={`${field.key}-help`}>{field.help}</p>
              <p className="muted" id={`${field.key}-effect`}>{field.effect}</p>
              {fieldError && <p className="settings-field-error" id={`${field.key}-error`}>{fieldError}</p>}
              {isChanged && <details className="settings-current-prompt"><summary>查看当前已保存的提示词</summary><pre>{snapshot.values[field.key]}</pre></details>}
            </div>;
          })}</div>
          <p className="settings-section-note">尽量忠实保留原意、关系与笑点，但模型无法凭空获得未提供的画面或前文。修改会记录到操作审计中；请勿填写密钥或私有漫画内容。</p>
        </section>
        {(['storage', 'entitlements', 'guest', 'translation', 'upload', 'feedback'] as const).map(group => <section className="panel settings-panel" key={group} aria-labelledby={`settings-${group}`}>
          <div className="settings-section-heading"><span className="settings-section-icon" aria-hidden="true">{group === 'upload' ? '↥' : '≡'}</span>
            <div><h2 id={`settings-${group}`}>{group === 'storage' ? '结果保留' : group === 'entitlements' ? '额度默认值' : group === 'guest' ? '匿名体验每日预算' : group === 'translation' ? '翻译速率' : group === 'upload' ? '上传保护' : '反馈保护'}</h2>
              <p className="muted">{group === 'storage' ? '注册账户单图结果默认保留 7 天，浏览器已保存的完整译图不受影响。游客及整本文件结果使用各自期限。' : group === 'entitlements' ? '设置新额度周期与新开通运营会员段的默认页数。' : group === 'guest' ? '按服务配置的额度时区自然日计次，游客、网络和全站预算分别控制。' : group === 'translation' ? '跨模式、语言和设备合计，不限制账户待处理任务数量。' : group === 'upload' ? '控制上传连接数量与等待时间，保持服务可用。' : '限制重复新增反馈，保留用户正常反馈与重试的空间。'}</p></div></div>
          <div className="settings-fields">{numericFields.filter(field => field.group === group).map(field => {
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
          <p className="settings-section-note">{group === 'storage' ? '保存后读取与清理统一按新期限执行。到期不自动重新翻译或扣费；缩短前请确认历史结果的影响。' : group === 'entitlements' ? '额度按新周期或新会员段生效；付费订阅使用产品绑定的权益版本。修改记录可在操作审计中查询。' : group === 'guest' ? '保存后按新限额与当天已用次数判断新受理；同一 UUID 重放或本人有效任务复用不再次计次。修改记录可在操作审计中查询。' : group === 'translation' ? '保存后即时用于新翻译准入，已消耗的分钟名额不会清零；每日与会员月页数权益独立计算。' : group === 'upload' ? '保存对新接纳的上传生效；已接纳的上传保持原有超时设置。' :
            '修改设置不会清零已经使用的反馈预算，也不会改变用户的翻译页数额度。'}</p>
        </section>)}
      </fieldset>
      <div className="panel settings-save-bar"><div><strong>{conflict ? '请先读取最新设置' : dirty ? '有未保存的更改' : '设置已同步'}</strong>
        <p className="muted">{invalid ? '请修正上方标出的设置后保存。' : dirty ? '核对修改后保存，离开此页前请保存更改。' : '调整上方设置后可保存；无需重启服务。'}</p></div>
        <button className="primary" disabled={busy || !dirty || invalid || conflict}>{operation === 'saving' ? '正在保存…' : '保存系统设置'}</button></div>
    </form>}
  </main>;
}
