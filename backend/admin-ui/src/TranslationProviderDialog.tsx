import {useEffect, useRef, useState, type InputHTMLAttributes} from 'react';
import {ApiError, authError, errorText, sendRequest} from './api';
import type {TranslationChannel, TranslationProvider} from './types';
import {channelProtocols, numericFields, protocolLabels, providerDraft, providerEndpoint, providerInput, textLimits, validateProvider, type ProviderField} from './translationProviderConfig';
import {time} from './ui';

export function TranslationProviderDialog({provider, channels, onClose, onSaved, onRefresh, onUnauthorized}: {
  provider?: TranslationProvider; channels: TranslationChannel[]; onClose: () => void;
  onSaved: () => void; onRefresh: () => void; onUnauthorized: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const saveController = useRef<AbortController | undefined>(undefined);
  const [draft, setDraft] = useState(() => providerDraft(provider));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const errors = attempted ? validateProvider(draft, channels, !provider) : {};
  const dirty = JSON.stringify(draft) !== JSON.stringify(providerDraft(provider));
  const protocols = channelProtocols(channels, draft.channel);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => {
      saveController.current?.abort();
      element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);

  function close() {if (!saveController.current) onClose();}
  function update(key: ProviderField, value: string) {setDraft(current => ({...current, [key]: value}));}
  function accessibility(key: ProviderField) {
    return {id: `provider-${key}`, name: key, 'aria-invalid': !!errors[key],
      'aria-describedby': `provider-${key}-help${errors[key] ? ` provider-${key}-error` : ''}`};
  }
  function hint(key: ProviderField, help: string) {
    return <><p className="muted" id={`provider-${key}-help`}>{help}</p>
      {errors[key] && <p className="settings-field-error" id={`provider-${key}-error`}>{errors[key]}</p>}</>;
  }
  function field(key: ProviderField, title: string, help: string, input: InputHTMLAttributes<HTMLInputElement> = {}) {
    return <div className="settings-field" key={key}>
      <label htmlFor={`provider-${key}`}>{title}{input.required !== false && <span className="provider-required">必填</span>}</label>
      <input required maxLength={key in textLimits ? textLimits[key as keyof typeof textLimits] : undefined} {...input} {...accessibility(key)} value={draft[key]} onChange={event => update(key, event.target.value)}/>
      {hint(key, help)}
    </div>;
  }

  async function save() {
    if (saveController.current || needsRefresh) return;
    setAttempted(true); setError('');
    if (Object.keys(validateProvider(draft, channels, !provider)).length) {
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    const controller = new AbortController(); saveController.current = controller;
    setBusy(true);
    try {
      await sendRequest(provider ? `${providerEndpoint}/${encodeURIComponent(provider.id)}` : providerEndpoint, {
        method: provider ? 'PUT' : 'POST', signal: controller.signal, headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(providerInput(draft)),
      });
      if (controller.signal.aborted) return;
      setDraft(current => ({...current, api_key: ''}));
      onSaved();
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (authError(failure)) onUnauthorized(errorText(failure));
      else {
        const uncertain = failure instanceof TypeError || (failure instanceof ApiError && failure.status >= 500);
        setNeedsRefresh(uncertain || (failure instanceof ApiError && [404, 409].includes(failure.status)));
        setError(uncertain ? '暂时无法确认保存结果。请关闭并刷新列表，核实供应商及版本后再操作，避免重复创建或保存。' : errorText(failure));
      }
    } finally {
      if (!controller.signal.aborted) {saveController.current = undefined; setBusy(false);}
    }
  }

  return <dialog className="provider-dialog" ref={dialog} aria-labelledby="provider-dialog-title" aria-describedby="provider-dialog-description"
    onCancel={event => {event.preventDefault(); close();}}>
    <div className="dialog-top"><h2 id="provider-dialog-title">{provider ? '编辑翻译供应商' : '新建翻译供应商'}</h2>
      <button type="button" className="secondary" disabled={busy} onClick={close} aria-label="关闭供应商配置">关闭 ×</button></div>
    <div className="dialog-content">
      <p id="provider-dialog-description" className="provider-description muted">{provider ?
        '修改参数或密钥会产生独立的新版本；已提交任务继续使用原版本。' :
        '每个供应商独立配置地址、模型和密钥。首个自动用于正文，漫画名需在列表中单独选择。'}</p>
      {provider && <div className="provider-revision"><span>当前版本 <code>{provider.revision_id}</code></span>
        <span>创建于 {time(provider.created_at)} · 更新于 {time(provider.updated_at)}</span></div>}
      <form ref={form} noValidate autoComplete="off" className="provider-form" onSubmit={event => {event.preventDefault(); void save();}} aria-busy={busy}>
        <fieldset className="config-body" disabled={busy || needsRefresh}>
          <legend className="sr-only">翻译供应商配置</legend>
          <section className="provider-section" aria-labelledby="provider-connection-title">
            <h3 id="provider-connection-title">渠道与连接</h3>
            <div className="settings-fields">
              {field('name', '供应商名称', '用于区分同一渠道下的不同供应商。', {autoFocus: true, placeholder: '例如：OpenAI 主线路'})}
              <div className="settings-field"><label htmlFor="provider-channel">来源渠道 <span className="provider-required">必填</span></label>
                <select required {...accessibility('channel')} value={draft.channel} onChange={event => {
                  const channel = event.target.value;
                  const supported = channelProtocols(channels, channel);
                  setDraft(current => ({...current, channel, protocol: supported.includes(current.protocol as typeof supported[number]) ? current.protocol : supported[0] ?? ''}));
                }}>
                  {!channels.some(channel => channel.id === draft.channel) && <option value={draft.channel} disabled>{draft.channel}（当前不可用）</option>}
                  {channels.map(channel => <option value={channel.id} key={channel.id} disabled={!channelProtocols(channels, channel.id).length}>
                    {channel.label}{channel.id !== 'openai' ? '（暂未支持配置）' : !channelProtocols(channels, channel.id).length ? '（暂无可用协议）' : ''}
                  </option>)}
                </select>{hint('channel', '当前支持 OpenAI 渠道，可为不同兼容服务分别创建供应商。')}</div>
              {field('base_url', 'API 基础地址', '填写包含版本路径的 HTTPS 基础地址，例如 https://api.openai.com/v1。密钥请填写在下方独立字段。', {type: 'url', spellCheck: false})}
              {field('model', '模型', '填写该供应商实际提供的文本模型标识。', {placeholder: '填写模型 ID', spellCheck: false})}
              <div className="settings-field"><label htmlFor="provider-protocol">接口协议 <span className="provider-required">必填</span></label>
                <select required {...accessibility('protocol')} value={draft.protocol} onChange={event => update('protocol', event.target.value)}>
                  {!protocols.some(protocol => protocol === draft.protocol) && <option value={draft.protocol} disabled>{draft.protocol || '请选择协议'}（当前不可用）</option>}
                  {protocols.map(protocol => <option value={protocol} key={protocol}>{protocolLabels[protocol]}</option>)}
                </select>{hint('protocol', 'Chat Completions 使用 /chat/completions；Responses 使用 /responses。')}</div>
              {field('user_agent', 'User-Agent', '随文本请求发送的客户端标识。', {spellCheck: false})}
            </div>
          </section>
          <section className="config-section provider-section" aria-labelledby="provider-credential-title">
            <h3 id="provider-credential-title">访问密钥与状态</h3>
            {provider && <p className="muted">当前密钥：{provider.credential_configured ? '已配置' : '未配置，请补充密钥'}</p>}
            {field('api_key', provider ? '替换 API 密钥（可选）' : 'API 密钥', provider ?
              '留空时保留现有密钥；填写新密钥会随配置保存为新版本。密钥不会回显或保存在浏览器存储中。' :
              '创建时必填。保存后仅显示配置状态，不会回显密钥或保存在浏览器存储中。',
              {type: 'password', required: !provider, autoComplete: 'new-password', spellCheck: false, autoCapitalize: 'none', placeholder: provider ? '留空保留现有密钥' : '输入供应商 API 密钥'})}
            <label className="provider-enabled"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({...draft, enabled: event.target.checked})}
              aria-describedby="provider-enabled-help"/>启用供应商</label>
            <p className="muted" id="provider-enabled-help">停用会暂停该供应商排队中的文本阶段；重新启用后恢复。{provider?.is_default && ' 此供应商用于正文，停用后常规翻译暂不可提交新任务。'}{provider?.is_title_default && ' 此供应商用于漫画名，停用后漫画名仅可返回已有缓存。'}</p>
          </section>
          {(['requests', 'pricing'] as const).map(group => <section className="config-section provider-section" key={group} aria-labelledby={`provider-${group}-title`}>
            <h3 id={`provider-${group}-title`}>{group === 'requests' ? '请求与分组' : '成本计量'}</h3>
            {group === 'pricing' && <p className="muted">单价仅用于正文翻译的成本计量，不作为调用预算上限；漫画名查询不计入此账本。</p>}
            <div className="settings-fields">{numericFields.filter(item => item.group === group).map(item => field(item.key, `${item.title}（${item.unit}）`,
              `${item.help} 范围 ${item.min}–${item.max}${item.integer ? '，整数' : ''}。`, {type: 'number', min: item.min, max: item.max, step: item.integer ? 1 : 'any'}))}
              {group === 'pricing' && field('pricing_version', '计价版本', '记录当前单价的来源或估算口径，与供应商配置版本分别管理。', {spellCheck: false})}
            </div>
          </section>)}
        </fieldset>
        {attempted && Object.keys(errors).length > 0 && <p className="error" role="alert">请修正表单中标出的字段后保存。</p>}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="provider-save-bar"><p className="muted" role="status">{busy ? '正在保存供应商，请稍候…' : needsRefresh ? '请先核实最新列表。' : dirty ? '有未保存的更改，关闭会放弃这些更改。' : '核对配置后保存。'}</p>
          <div className="provider-actions">{needsRefresh ? <button type="button" className="primary" onClick={onRefresh}>关闭并刷新列表</button> :
            <button type="submit" className="primary" disabled={busy || (!!provider && !dirty)}>{busy ? '正在保存…' : provider ? '保存供应商' : '创建供应商'}</button>}
            <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button></div></div>
      </form>
    </div>
  </dialog>;
}
