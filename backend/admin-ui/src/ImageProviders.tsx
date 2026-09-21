import {useCallback, useEffect, useRef, useState} from 'react';
import {ApiError, authError, errorText, request} from './api';
import {imageHash} from './TaskActions';
import {Badge, Empty, Jump, Table, time} from './ui';
import {BillingDialog} from './BillingShared';

type Config = {id: string; label: string; protocol: 'openai_images'; base_url: string; credential_ref: string; model: string;
  image_field: string; user_agent: string; parameters: Record<string, string | number | boolean>; allowed_parameters: string[];
  timeout_seconds: number; max_bytes: number; max_pixels: number; max_dimension: number; input_formats: string[];
  download_hosts: string[]; concurrency: number; enabled: boolean};
type Provider = Config & {credential_configured: boolean; validated_at: string | null; validation_job_id: string | null;
  latest_test: {id: string; status: string; created_at: string} | null};
type Callbacks = {onUnauthorized: (message: string) => void};
const endpoint = '/v1/admin/providers';
const defaults: Config = {id: '', label: '', protocol: 'openai_images', base_url: '', credential_ref: 'OPENAI_API_KEY', model: '',
  image_field: 'image', user_agent: 'NodeComics/0.1', parameters: {},
  allowed_parameters: ['quality', 'size', 'output_format', 'background', 'input_fidelity', 'response_format', 'moderation'],
  timeout_seconds: 600, max_bytes: 20971520, max_pixels: 24000000, max_dimension: 8192,
  input_formats: ['image/png', 'image/jpeg', 'image/webp'], download_hosts: [], concurrency: 2, enabled: false};
const split = (value: string) => value.split(/[,\n]/).map(item => item.trim()).filter(Boolean);

function ProviderEditor({provider, onClose, onSaved, onUnauthorized}: Callbacks & {
  provider?: Provider; onClose: () => void; onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef(false);
  const [draft, setDraft] = useState<Config>(() => Object.fromEntries(Object.keys(defaults).map(key => [key, provider?.[key as keyof Config] ?? defaults[key as keyof Config]])) as Config);
  const [parameters, setParameters] = useState(() => JSON.stringify(provider?.parameters ?? {}, null, 2));
  const [allowed, setAllowed] = useState(() => (provider?.allowed_parameters ?? defaults.allowed_parameters).join(', '));
  const [formats, setFormats] = useState(() => (provider?.input_formats ?? defaults.input_formats).join(', '));
  const [hosts, setHosts] = useState(() => (provider?.download_hosts ?? []).join(', '));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, element = dialog.current!;
    element.showModal(); return () => {element.close(); if (opener?.isConnected) opener.focus();};
  }, []);
  function change<K extends keyof Config>(key: K, value: Config[K]) {setDraft(current => ({...current, [key]: value}));}
  async function save() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      let parsed: unknown;
      try {parsed = JSON.parse(parameters);} catch {throw Error('可选参数必须为有效 JSON 对象。');}
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some(value => !['string', 'number', 'boolean'].includes(typeof value))) {
        throw Error('可选参数必须是对象，值仅支持文字、数字或布尔值。');
      }
      const whitelist = split(allowed), entries = Object.keys(parsed);
      if (entries.some(key => !whitelist.includes(key) || ['model', 'prompt', 'image', 'image[]', 'n', 'stream'].includes(key))) throw Error('可选参数超出白名单或占用了系统保留字段。');
      await request(`${endpoint}/${encodeURIComponent(draft.id)}`, {method: 'PUT', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...draft, parameters: parsed, allowed_parameters: whitelist, input_formats: split(formats), download_hosts: split(hosts)})});
      onSaved();
    } catch (failure) {
      if (authError(failure)) onUnauthorized(errorText(failure)); else setError(errorText(failure));
    } finally {pending.current = false; setBusy(false);}
  }
  const numericFields = [
    ['concurrency', '并发请求数', 1, 32], ['timeout_seconds', '请求超时（秒）', 10, 1800],
    ['max_bytes', '输入最大字节数', 1024, 52428800], ['max_pixels', '输入最大像素数', 1, 100000000],
    ['max_dimension', '输入最长边', 32, 32768],
  ] as const;
  return <dialog className="provider-dialog" ref={dialog} aria-labelledby="image-provider-title" onCancel={event => {event.preventDefault(); if (!busy) onClose();}}>
    <div className="dialog-top"><h2 id="image-provider-title">{provider ? '编辑图片供应商' : '新建图片供应商'}</h2><button className="secondary" disabled={busy} onClick={onClose}>关闭 ×</button></div>
    <div className="dialog-content"><p className="muted">通过 OpenAI 兼容图片编辑接口调用。密钥由服务端环境变量提供，此处只填写变量名称。变更模型或参数后需重新验证。</p>
      <form className="provider-form" onSubmit={event => {event.preventDefault(); void save();}} autoComplete="off">
        <fieldset className="config-body" disabled={busy}><legend className="sr-only">图片供应商配置</legend>
          <section className="image-config-section"><h3>连接与调用</h3><div className="settings-fields">
            <label className="settings-field">供应商编号<input required pattern="[a-zA-Z0-9_-]{1,80}" maxLength={80} readOnly={!!provider} value={draft.id} onChange={event => change('id', event.target.value)}/></label>
            <label className="settings-field">显示名称<input required maxLength={100} value={draft.label} onChange={event => change('label', event.target.value)}/></label>
            <label className="settings-field">服务地址<input required type="url" maxLength={1000} placeholder="https://provider.example/v1" value={draft.base_url} onChange={event => change('base_url', event.target.value)}/></label>
            <label className="settings-field">模型<input required maxLength={120} value={draft.model} onChange={event => change('model', event.target.value)}/></label>
            <label className="settings-field">密钥环境变量名<input required pattern="[A-Z][A-Z0-9_]{0,100}" maxLength={101} value={draft.credential_ref} onChange={event => change('credential_ref', event.target.value)}/></label>
            {numericFields.slice(0, 2).map(([key, name, min, max]) => <label className="settings-field" key={key}>{name}<input type="number" required min={min} max={max} step={1} value={draft[key]} onChange={event => change(key, Number(event.target.value))}/></label>)}
          </div></section>
          <details className="image-config-advanced"><summary>图片输入限制</summary><div className="settings-fields">
            <label className="settings-field">图片字段<select value={draft.image_field} onChange={event => change('image_field', event.target.value)}><option>image</option><option>image[]</option></select></label>
            {numericFields.slice(2).map(([key, name, min, max]) => <label className="settings-field" key={key}>{name}<input type="number" required min={min} max={max} step={1} value={draft[key]} onChange={event => change(key, Number(event.target.value))}/></label>)}
            <label className="settings-field">输入 MIME 类型（逗号分隔）<input required value={formats} onChange={event => setFormats(event.target.value)}/></label>
          </div></details>
          <details className="image-config-advanced"><summary>高级请求配置</summary><div className="settings-fields">
            <label className="settings-field">User-Agent<input required maxLength={200} value={draft.user_agent} onChange={event => change('user_agent', event.target.value)}/></label>
            <label className="settings-field">结果下载域名白名单（逗号分隔）<input value={hosts} onChange={event => setHosts(event.target.value)} placeholder="留空采用现有供应商下载限制"/></label>
            <label className="settings-field">可选参数白名单（逗号分隔）<input value={allowed} onChange={event => setAllowed(event.target.value)}/></label>
            <label className="settings-field">可选参数 JSON<textarea rows={6} value={parameters} onChange={event => setParameters(event.target.value)}/></label>
          </div></details>
          <label><input type="checkbox" checked={draft.enabled} onChange={event => change('enabled', event.target.checked)}/> 启用供应商，允许后续 AI 重绘使用</label>
          <p className="panel-note">保存不会调用供应商。真实图片测试需启用且服务端已配置对应密钥。</p>
          <button className="primary">{busy ? '正在保存…' : '保存配置'}</button>
        </fieldset>
      </form>{error && <p className="error" role="alert">{error}</p>}
    </div>
  </dialog>;
}

type TestOperation = {key: string; hash: string; name: string; language: string};
function ProviderTest({provider, onChanged, onClose, onUnauthorized}: Callbacks & {provider: Provider; onChanged: () => void; onClose: () => void}) {
  const storageKey = `nc-admin-benefit:image-test:${provider.id}`;
  const [operation, setOperation] = useState<TestOperation | undefined>(() => {
    try {return JSON.parse(sessionStorage.getItem(storageKey) || 'null') || undefined;} catch {return undefined;}
  });
  const [file, setFile] = useState<File>(), [language, setLanguage] = useState('zh-Hans'), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [jobId, setJobId] = useState('');
  const pending = useRef(false);
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (!file) throw Error('请选择测试图片。');
      const hash = await imageHash(file);
      if (operation && (hash !== operation.hash || file.name !== operation.name)) throw Error(`请重新选择原测试图片「${operation.name}」，以原操作键核实结果。`);
      const current = operation || {key: crypto.randomUUID(), hash, name: file.name, language};
      if (!operation && !confirmed) throw Error('请确认本次测试会调用真实图片模型并产生费用。');
      sessionStorage.setItem(storageKey, JSON.stringify(current)); setOperation(current);
      const body = new FormData(); body.set('image', file); body.set('target_language', current.language);
      const job = await request<{id: string}>(`${endpoint}/${encodeURIComponent(provider.id)}/test`, {
        method: 'POST', headers: {'Idempotency-Key': current.key}, body,
      });
      sessionStorage.removeItem(storageKey); setOperation(undefined); setJobId(job.id); setConfirmed(false); onChanged();
    } catch (failure) {
      if (authError(failure) && !(failure instanceof ApiError && failure.code === 'PLUS_REQUIRED')) onUnauthorized(errorText(failure)); else setError(errorText(failure));
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        sessionStorage.removeItem(storageKey); setOperation(undefined);
      }
    } finally {pending.current = false; setBusy(false);}
  }
  return <BillingDialog title={`真实图片测试 · ${provider.label}`} className="image-test-dialog" onClose={onClose} busy={busy}>
    <section className="panel membership-actions" aria-label="真实图片测试">
    <p className="muted">{provider.model} · {provider.base_url}</p>
    <p className="attention">测试将把所选图片发送给此供应商，调用真实图片模型并产生供应商费用，同时使用当前管理员个人重绘权益与页数额度。任务异步执行；只有收到可解码译图并完成持久化，才记录验证通过。</p>
    <p className="panel-note">需要当前管理员具有有效 PLUS 或重绘赠送额度。<Jump view="users">前往用户管理查看或赠送额度 ↗</Jump></p>
    {operation && <p role="status">上一笔提交结果尚未确认。请选择原文件「{operation.name}」，恢复同一测试请求；不会创建第二笔测试任务。</p>}
    <form onSubmit={event => {event.preventDefault(); void submit();}}><fieldset className="benefit-fields" disabled={busy}>
      <label>测试图片<input type="file" accept={provider.input_formats.join(',')} required onChange={event => setFile(event.target.files?.[0])}/></label>
      <label>目标语言<select disabled={!!operation} value={operation?.language ?? language} onChange={event => setLanguage(event.target.value)}>
        {Object.entries({'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', en: 'English', ja: '日本語', ko: '한국어'}).map(([key, text]) => <option value={key} key={key}>{text}</option>)}
      </select></label>
      {!operation && <label style={{display: 'flex', alignItems: 'center', gap: 8}}><input style={{width: 'auto', flex: '0 0 auto'}} type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/> 已确认调用此供应商并承担本次测试费用</label>}
      <button className="primary" disabled={!file || (!operation && !confirmed)}>{busy ? '正在提交…' : operation ? '恢复原测试请求' : '提交真实图片测试'}</button>
    </fieldset></form>
    {error && <p className="error" role="alert">{error}</p>}{jobId && <p className="settings-notice" role="status">测试任务已提交。<Jump view="tasks" params={{q: jobId}}>查看测试任务 ↗</Jump></p>}
    {provider.latest_test && <div className="image-config-section"><h3>最近测试回执</h3><LatestTest test={provider.latest_test} onUnauthorized={onUnauthorized}/>
      <button type="button" className="text-link" disabled={busy} onClick={onChanged}>刷新测试状态</button></div>}
  </section></BillingDialog>;
}

function LatestTest({test, onUnauthorized}: Callbacks & {test: NonNullable<Provider['latest_test']>}) {
  const [failure, setFailure] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setFailure('');
    if (['failed', 'outcome_unknown', 'unknown_released'].includes(test.status)) {
      request<{error_code?: string; error_message?: string}>(`/v1/admin/monitor/tasks/${encodeURIComponent(test.id)}`, {signal: controller.signal})
        .then(task => {if (!controller.signal.aborted) setFailure(task.error_message || task.error_code || '请查看任务详情核实原因。');})
        .catch(error => {if (!controller.signal.aborted) {if (authError(error)) onUnauthorized(errorText(error)); else setFailure(`原因读取失败：${errorText(error)}`);}});
    }
    return () => controller.abort();
  }, [test.id, test.status, onUnauthorized]);
  return <div className="image-test-receipt"><Badge value={test.status}/><small>{time(test.created_at)}</small>{failure && <p className="error">{failure}</p>}
    <Jump view="tasks" params={{q: test.id}}>测试任务 ↗</Jump></div>;
}

function pendingTest(providerId: string) {
  return !!sessionStorage.getItem(`nc-admin-benefit:image-test:${providerId}`);
}

export function ImageProvidersPage({onUnauthorized}: Callbacks) {
  const [data, setData] = useState<Provider[]>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<Provider | 'new'>(), [testing, setTesting] = useState<string>();
  const [notice, setNotice] = useState(''), [mutating, setMutating] = useState(false);
  const loadController = useRef<AbortController | undefined>(undefined), mutation = useRef(false);
  const reload = useCallback(async () => {
    const controller = new AbortController(); loadController.current?.abort(); loadController.current = controller;
    setBusy(true); setError('');
    try {const result = await request<{items: Provider[]}>(endpoint, {signal: controller.signal}); if (!controller.signal.aborted) setData(result.items);}
    catch (failure) {if (!controller.signal.aborted) {if (authError(failure)) onUnauthorized(errorText(failure)); else setError(errorText(failure));}}
    finally {if (!controller.signal.aborted) setBusy(false);}
  }, [onUnauthorized]);
  useEffect(() => {document.title = '图片供应商 · Node Comics 管理后台'; void reload(); return () => loadController.current?.abort();}, [reload]);
  async function toggle(provider: Provider) {
    if (mutation.current || busy) return;
    mutation.current = true; setMutating(true); setError(''); setNotice('');
    try {
      await request(`${endpoint}/${encodeURIComponent(provider.id)}`, {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({enabled: !provider.enabled})});
      setNotice(`${provider.label}已${provider.enabled ? '停用' : '启用'}。`); await reload();
    } catch (failure) {if (authError(failure)) onUnauthorized(errorText(failure)); else setError(`${errorText(failure)} 请刷新列表核实状态。`);}
    finally {mutation.current = false; setMutating(false);}
  }
  const testProvider = data?.find(row => row.id === testing);
  return <main id="main" tabIndex={-1} className="translation-providers admin-surface">
    <div className="page-heading"><div><p className="eyebrow">IMAGE PROVIDERS</p><h1>图片供应商</h1><p className="muted">管理 AI 重绘配置、启停状态与真实图片验证记录。</p></div>
      <div className="provider-actions"><button className="secondary" disabled={busy || mutating} onClick={() => void reload()}>↻ 刷新列表</button><button className="primary" disabled={busy || mutating || !!error} onClick={() => setEditing('new')}>＋ 新建供应商</button></div></div>
    <section className="panel provider-guide"><p>新任务按供应商编号顺序选择首个已启用且密钥可用的图片供应商。已创建的任务保留提交时的模型与参数。</p>
      <p>验证状态表示图片编辑曾成功交付，不能用模型列表或聊天接口测试替代。保存配置和查看列表不会调用图片模型。</p></section>
    {notice && <p className="settings-notice" role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}
    {!data && busy && <p className="loading" role="status">正在读取图片供应商…</p>}
    {data && <section className="panel list-panel" aria-label="图片供应商列表" aria-busy={busy || mutating}>
      {!data.length ? <Empty>尚无图片供应商</Empty> : <Table heads={['供应商 / 模型', '接口 / 密钥', '状态 / 验证', '最近测试', '操作']}>{data.map(row => <tr key={row.id}>
        <td><b>{row.label}</b><small>{row.model}</small><small><code>{row.id}</code></small></td>
        <td>{row.base_url}<small>{row.credential_ref} · {row.credential_configured ? '已配置' : '未配置'}</small></td>
        <td><span className={`badge ${row.enabled ? 'good' : 'warn'}`}>{row.enabled ? '已启用' : '已停用'}</span><small>{row.validated_at ? `验证通过于 ${time(row.validated_at)}` : '当前配置尚未验证'}</small>
          {row.validation_job_id && <Jump view="tasks" params={{q: row.validation_job_id}}>验证任务 ↗</Jump>}</td>
        <td>{row.latest_test ? <LatestTest test={row.latest_test} onUnauthorized={onUnauthorized}/> : '尚无测试'}</td>
        <td><div className="provider-row-actions"><button className="text-link" disabled={busy || mutating || !!error} onClick={() => setEditing(row)}>编辑</button>
          <button className="text-link" disabled={busy || mutating || !!error} onClick={() => void toggle(row)}>{row.enabled ? '停用' : '启用'}</button>
          <button className="text-link" disabled={busy || mutating || !!error || (!pendingTest(row.id) && (!row.enabled || !row.credential_configured))} onClick={() => setTesting(row.id)}>图片测试</button></div>
          {pendingTest(row.id) ? <small>有待恢复的测试提交</small> : (!row.enabled || !row.credential_configured) && <small>启用并配置服务端密钥后可测试</small>}</td>
      </tr>)}</Table>}
    </section>}
    {testProvider && <ProviderTest key={testProvider.id} provider={testProvider} onChanged={() => void reload()} onClose={() => setTesting(undefined)} onUnauthorized={onUnauthorized}/>}
    {editing && <ProviderEditor provider={editing === 'new' ? undefined : editing} onUnauthorized={onUnauthorized} onClose={() => setEditing(undefined)}
      onSaved={() => {setEditing(undefined); setNotice('配置已保存。变更模型或参数后的验证状态以列表为准。'); void reload();}}/>}
  </main>;
}
