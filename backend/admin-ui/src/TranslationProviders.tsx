import {useCallback, useEffect, useRef, useState} from 'react';
import {authError, errorText, request, sendRequest} from './api';
import {TranslationProviderDialog} from './TranslationProviderDialog';
import {channelProtocols, protocolLabels, reasoningLabels, routingFields, providerEndpoint} from './translationProviderConfig';
import type {TranslationProvider, TranslationProviders} from './types';
import {Table, time} from './ui';

export function TranslationProvidersPage({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const [data, setData] = useState<TranslationProviders>();
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<string>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<TranslationProvider | 'new'>();
  const [pending, setPending] = useState<string>();
  const loadController = useRef<AbortController | undefined>(undefined);
  const actionController = useRef<AbortController | undefined>(undefined);
  const busy = loading || !!pending;
  const blocked = busy || !!loadError || !!actionError;
  const canCreate = !!data && channelProtocols(data.channels, 'openai').length > 0;
  const totalWeight = (key: 'text_weight' | 'title_weight') => (data?.items ?? []).reduce(
    (sum, provider) => sum + (provider.enabled && provider.credential_configured ? provider[key] : 0), 0);

  const reload = useCallback(async (clearNotice = true) => {
    const controller = new AbortController();
    loadController.current?.abort(); loadController.current = controller;
    setLoading(true); setLoadError(''); setActionError('');
    if (clearNotice) setNotice('');
    try {
      const result = await request<TranslationProviders>(providerEndpoint, {signal: controller.signal});
      if (controller.signal.aborted) return;
      setData(result); setLoadedAt(new Date().toISOString());
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (authError(failure)) onUnauthorized(errorText(failure)); else setLoadError(errorText(failure));
    } finally {
      if (loadController.current === controller) {loadController.current = undefined; setLoading(false);}
    }
  }, [onUnauthorized]);

  useEffect(() => {
    document.title = '翻译供应商 · Node Comics 管理后台';
    void reload();
    return () => {loadController.current?.abort(); loadController.current = undefined; actionController.current?.abort();};
  }, [reload]);

  async function toggle(provider: TranslationProvider) {
    if (blocked || actionController.current || loadController.current) return;
    const controller = new AbortController(); actionController.current = controller;
    setPending(provider.id); setNotice(''); setActionError('');
    try {
      const path = `${providerEndpoint}/${encodeURIComponent(provider.id)}`;
      await sendRequest(path, {method: 'PATCH', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({enabled: !provider.enabled})});
      if (controller.signal.aborted) return;
      setNotice(provider.enabled ? `已停用「${provider.name}」，不再参与分流，其排队中的正文翻译将暂停。` : `已启用「${provider.name}」，按配置权重参与分流。`);
      await reload(false);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (authError(failure)) onUnauthorized(errorText(failure));
      else setActionError(`${errorText(failure)} 请刷新列表核实当前状态后再操作。`);
    } finally {
      if (!controller.signal.aborted) {actionController.current = undefined; setPending(undefined);}
    }
  }

  return <main id="main" tabIndex={-1} className="translation-providers">
    <div className="page-heading"><div><p className="eyebrow">TRANSLATION PROVIDERS</p><h1>翻译供应商</h1>
      <p className="muted">正文与漫画名分别设置权重，按比例分流到多个 LLM 供应商。</p></div>
      <div className="provider-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>{loading ? '正在刷新…' : '↻ 刷新列表'}</button>
        <button type="button" className="primary" disabled={blocked || !canCreate} onClick={() => {setNotice(''); setEditing('new');}}>＋ 新建供应商</button></div></div>
    <div className="sync-line"><span role="status">{pending ? '正在更新供应商…' : loading ? '正在读取供应商…' : loadError || actionError ? '请刷新列表核实最新状态' : `已更新 ${time(loadedAt)}`}</span>
      <span>时间按浏览器本地时区显示</span></div>
    <section className="panel provider-guide" aria-label="供应商生效规则">
      <p><strong>按比例分流 · 两种用途独立配置</strong></p>
      <p>启用且对应用途权重大于 0 的供应商参与分流。权重 3:1 表示大量不同输入约按 75%:25% 分配；相同内容与目标语言稳定选择供应商，便于复用结果。</p>
      <p>权重为 0 时停止分配新请求，已有正文任务继续原供应商；停用则暂停其已有任务。分流比例不代表 HTTP 并发配额，正文仍受供应商 RPM 与共享文本执行位限制。</p>
      <p>修改模型参数或密钥会产生新版本，已提交的正文任务保持原版本。漫画名只在缓存未命中时分流，调整配置不清除已有缓存。</p>
    </section>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
    {loadError && <div className="error" role="alert">{loadError} {data ? '当前列表可能已过时，操作暂不可用。' : '暂时无法读取供应商。'}
      <button type="button" className="text-link" disabled={busy} onClick={() => void reload(false)}>重新读取列表</button></div>}
    {actionError && <div className="error" role="alert">{actionError}<button type="button" className="text-link" disabled={busy} onClick={() => void reload()}>刷新列表</button></div>}
    {data && !loadError && !loading && !canCreate && <p className="provider-warning" role="status">当前没有可配置的 OpenAI 渠道或支持的协议。请检查服务端渠道配置后刷新列表。</p>}
    {data && !loadError && !loading && data.items.length > 0 && routingFields.filter(({key}) => !totalWeight(key)).map(({key, label}) =>
      <p key={key} className="provider-warning" role="status">{label}暂无可用分流供应商。请启用已配置密钥的供应商，并将{label}权重设为大于 0。{key === 'title_weight' ? '已有漫画名缓存仍可使用。' : '常规翻译暂不可提交新任务。'}</p>)}
    <section className="panel list-panel provider-list" aria-label="翻译供应商列表" aria-busy={busy}>
      {!data ? <div className="loading" role="status">{loading ? '正在读取翻译供应商…' : '暂时无法读取列表，请刷新重试。'}</div> :
        !data.items.length ? <div className="empty"><span aria-hidden="true">⇄</span><h3>尚未创建翻译供应商</h3>
          <p>添加供应商并填写模型、密钥，以及正文与漫画名的分流权重。</p>
          <button type="button" className="primary" disabled={blocked || !canCreate} onClick={() => setEditing('new')}>新建翻译供应商</button></div> :
          <Table heads={['供应商 / 渠道', '模型 / 接口', '状态 / 密钥', '版本 / 最近更新', '操作']}>
            {data.items.map(provider => {
              return <tr key={provider.id}>
                <td><div className="provider-name"><b>{provider.name}</b></div>
                  {routingFields.map(({key, label}) => <small key={key}>{provider.enabled && provider.credential_configured && provider[key] > 0 ?
                    `${label}权重 ${provider[key]} · 约 ${(provider[key] / totalWeight(key) * 100).toFixed(1)}%` : `${label}不分流 · 权重 ${provider[key]}`}</small>)}
                  <small>{data.channels.find(channel => channel.id === provider.channel)?.label ?? provider.channel}</small>
                  <small>ID <code>{provider.id}</code></small></td>
                <td><b>{provider.config.model}</b><small>{protocolLabels[provider.config.protocol] ?? provider.config.protocol}</small>
                  <small>思考：{reasoningLabels[provider.config.reasoning_effort ?? 'provider_default']}</small>
                  <small>{provider.config.base_url}</small></td>
                <td><span className={`badge ${provider.enabled ? 'good' : 'warn'}`}>{provider.enabled ? '已启用' : '已停用'}</span>
                  <small>{provider.credential_configured ? '密钥已配置' : '密钥未配置'}</small>
                  <small>上游上限 {provider.requests_per_minute} 次 / 分钟</small>
                  {!provider.enabled && <small>排队文本阶段暂停</small>}</td>
                <td><code>{provider.revision_id}</code><small>{time(provider.updated_at)}</small></td>
                <td><div className="provider-row-actions">
                  <button type="button" className="text-link" disabled={blocked || provider.channel !== 'openai'} aria-label={`编辑 ${provider.name}`} onClick={() => {setNotice(''); setEditing(provider);}}>编辑</button>
                  <button type="button" className="text-link" disabled={blocked} aria-label={`${provider.enabled ? '停用' : '启用'} ${provider.name}`} onClick={() => void toggle(provider)}>
                    {pending === provider.id ? '正在更新…' : provider.enabled ? '停用' : '启用'}</button>
                </div>{!provider.enabled && <small>启用后按权重参与分流</small>}{provider.channel !== 'openai' && <small>此渠道暂未支持编辑</small>}</td>
              </tr>;
            })}
          </Table>}
    </section>
    {data && <p className="footnote provider-footnote">共 {data.items.length} 个供应商 · {data.items.filter(provider => provider.enabled).length} 个已启用。密钥仅显示配置状态。</p>}
    {editing && data && <TranslationProviderDialog provider={editing === 'new' ? undefined : editing} channels={data.channels} onUnauthorized={onUnauthorized}
      onClose={() => setEditing(undefined)} onRefresh={() => {setEditing(undefined); void reload(); requestAnimationFrame(() => document.getElementById('main')?.focus());}}
      onSaved={() => {setNotice(editing === 'new' ? '供应商已创建，按启用状态与两种用途的权重参与分流。' : '供应商已保存，分流权重仅影响后续分配，已提交的正文任务仍保持原版本。'); setEditing(undefined); void reload(false); requestAnimationFrame(() => document.getElementById('main')?.focus());}}/>}
  </main>;
}
