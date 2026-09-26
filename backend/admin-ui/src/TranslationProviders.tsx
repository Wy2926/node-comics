import {useCallback, useEffect, useRef, useState} from 'react';
import {authError, errorText, request, sendRequest} from './api';
import {TranslationProviderDialog} from './TranslationProviderDialog';
import {channelProtocols, protocolLabels, providerEndpoint} from './translationProviderConfig';
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
  const [pending, setPending] = useState<{id: string; kind: 'toggle' | 'default' | 'title-default'}>();
  const loadController = useRef<AbortController | undefined>(undefined);
  const actionController = useRef<AbortController | undefined>(undefined);
  const busy = loading || !!pending;
  const blocked = busy || !!loadError || !!actionError;
  const canCreate = !!data && channelProtocols(data.channels, 'openai').length > 0;
  const defaultProvider = data?.items.find(provider => provider.is_default);
  const titleProvider = data?.items.find(provider => provider.is_title_default);

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

  async function act(provider: TranslationProvider, kind: 'toggle' | 'default' | 'title-default') {
    if (blocked || actionController.current || loadController.current) return;
    const controller = new AbortController(); actionController.current = controller;
    setPending({id: provider.id, kind}); setNotice(''); setActionError('');
    try {
      const path = `${providerEndpoint}/${encodeURIComponent(provider.id)}`;
      await sendRequest(kind !== 'toggle' ? `${path}/${kind}` : path, kind !== 'toggle' ?
        {method: 'POST', signal: controller.signal} :
        {method: 'PATCH', signal: controller.signal, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({enabled: !provider.enabled})});
      if (controller.signal.aborted) return;
      setNotice(kind === 'default' ? `已将「${provider.name}」设为正文默认，仅影响后续正文任务。` :
        kind === 'title-default' ? `已将「${provider.name}」设为漫画名默认，后续未命中缓存时使用。` :
        provider.enabled ? `已停用「${provider.name}」，其排队中的正文翻译将暂停。${provider.is_title_default ? '漫画名新查询仅可使用缓存。' : ''}` : `已启用「${provider.name}」。`);
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
      <p className="muted">管理 LLM 供应商，分别选择正文翻译与漫画名查询使用的模型。</p></div>
      <div className="provider-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>{loading ? '正在刷新…' : '↻ 刷新列表'}</button>
        <button type="button" className="primary" disabled={blocked || !canCreate} onClick={() => {setNotice(''); setEditing('new');}}>＋ 新建供应商</button></div></div>
    <div className="sync-line"><span role="status">{pending ? '正在更新供应商…' : loading ? '正在读取供应商…' : loadError || actionError ? '请刷新列表核实最新状态' : `已更新 ${time(loadedAt)}`}</span>
      <span>时间按浏览器本地时区显示</span></div>
    <section className="panel provider-guide" aria-label="供应商生效规则">
      <p><strong>正文与漫画名分别选择供应商</strong></p>
      <p>首个供应商自动用于正文；漫画名需单独选择。两者可选同一供应商，也可新建不同配置，切换互不影响。</p>
      <p>修改参数或密钥会产生新版本，已提交的正文任务保持原版本。漫画名在未命中缓存时使用当前选择的配置；切换不清除已有缓存。</p>
    </section>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
    {loadError && <div className="error" role="alert">{loadError} {data ? '当前列表可能已过时，操作暂不可用。' : '暂时无法读取供应商。'}
      <button type="button" className="text-link" disabled={busy} onClick={() => void reload(false)}>重新读取列表</button></div>}
    {actionError && <div className="error" role="alert">{actionError}<button type="button" className="text-link" disabled={busy} onClick={() => void reload()}>刷新列表</button></div>}
    {data && !loadError && !loading && !canCreate && <p className="provider-warning" role="status">当前没有可配置的 OpenAI 渠道或支持的协议。请检查服务端渠道配置后刷新列表。</p>}
    {data && !loadError && !loading && data.items.length > 0 && (!defaultProvider || !defaultProvider.enabled || !defaultProvider.credential_configured) &&
      <p className="provider-warning" role="status">{!defaultProvider ? '尚未设置正文默认供应商，请为后续任务选择供应商。' :
        !defaultProvider.enabled ? `正文供应商「${defaultProvider.name}」已停用。常规翻译暂不可提交新任务。可重新启用或切换供应商。` :
          `正文供应商「${defaultProvider.name}」尚未配置密钥，请编辑并补充密钥。`}</p>}
    {data && !loadError && !loading && data.items.length > 0 && (!titleProvider || !titleProvider.enabled || !titleProvider.credential_configured) &&
      <p className="provider-warning" role="status">{!titleProvider ? '尚未选择漫画名供应商，请点击“用于漫画名”。' :
        !titleProvider.enabled ? `漫画名供应商「${titleProvider.name}」已停用，请启用或重新选择。` :
          `漫画名供应商「${titleProvider.name}」尚未配置密钥，请编辑并补充密钥。`}漫画名目前仅可返回已有缓存。</p>}
    <section className="panel list-panel provider-list" aria-label="翻译供应商列表" aria-busy={busy}>
      {!data ? <div className="loading" role="status">{loading ? '正在读取翻译供应商…' : '暂时无法读取列表，请刷新重试。'}</div> :
        !data.items.length ? <div className="empty"><span aria-hidden="true">⇄</span><h3>尚未创建翻译供应商</h3>
          <p>添加供应商并填写模型与密钥。首个自动用于正文，漫画名需单独选择。</p>
          <button type="button" className="primary" disabled={blocked || !canCreate} onClick={() => setEditing('new')}>新建翻译供应商</button></div> :
          <Table heads={['供应商 / 渠道', '模型 / 接口', '状态 / 密钥', '版本 / 最近更新', '操作']}>
            {data.items.map(provider => {
              const current = pending?.id === provider.id ? pending.kind : undefined;
              return <tr key={provider.id}>
                <td><div className="provider-name"><b>{provider.name}</b>{provider.is_default && <span className="badge accent">正文默认</span>}{provider.is_title_default && <span className="badge accent">漫画名默认</span>}</div>
                  <small>{data.channels.find(channel => channel.id === provider.channel)?.label ?? provider.channel}</small>
                  <small>ID <code>{provider.id}</code></small></td>
                <td><b>{provider.config.model}</b><small>{protocolLabels[provider.config.protocol] ?? provider.config.protocol}</small>
                  <small>{provider.config.base_url}</small></td>
                <td><span className={`badge ${provider.enabled ? 'good' : 'warn'}`}>{provider.enabled ? '已启用' : '已停用'}</span>
                  <small>{provider.credential_configured ? '密钥已配置' : '密钥未配置'}</small>
                  {!provider.enabled && <small>排队文本阶段暂停</small>}</td>
                <td><code>{provider.revision_id}</code><small>{time(provider.updated_at)}</small></td>
                <td><div className="provider-row-actions">
                  <button type="button" className="text-link" disabled={blocked || provider.channel !== 'openai'} aria-label={`编辑 ${provider.name}`} onClick={() => {setNotice(''); setEditing(provider);}}>编辑</button>
                  <button type="button" className="text-link" disabled={blocked} aria-label={`${provider.enabled ? '停用' : '启用'} ${provider.name}`} onClick={() => void act(provider, 'toggle')}>
                    {current === 'toggle' ? '正在更新…' : provider.enabled ? '停用' : '启用'}</button>
                  <button type="button" className="text-link" disabled={blocked || provider.is_default || !provider.enabled} aria-label={`将 ${provider.name} 用于正文`} onClick={() => void act(provider, 'default')}>
                    {current === 'default' ? '正在切换…' : provider.is_default ? '当前正文' : '用于正文'}</button>
                  <button type="button" className="text-link" disabled={blocked || provider.is_title_default || !provider.enabled} aria-label={`将 ${provider.name} 用于漫画名`} onClick={() => void act(provider, 'title-default')}>
                    {current === 'title-default' ? '正在切换…' : provider.is_title_default ? '当前漫画名' : '用于漫画名'}</button>
                </div>{!provider.enabled && <small>启用后可选择用途</small>}{provider.channel !== 'openai' && <small>此渠道暂未支持编辑</small>}</td>
              </tr>;
            })}
          </Table>}
    </section>
    {data && <p className="footnote provider-footnote">共 {data.items.length} 个供应商 · {data.items.filter(provider => provider.enabled).length} 个已启用。密钥仅显示配置状态。</p>}
    {editing && data && <TranslationProviderDialog provider={editing === 'new' ? undefined : editing} channels={data.channels} onUnauthorized={onUnauthorized}
      onClose={() => setEditing(undefined)} onRefresh={() => {setEditing(undefined); void reload(); requestAnimationFrame(() => document.getElementById('main')?.focus());}}
      onSaved={() => {setNotice(editing === 'new' ? '供应商已创建。首个自动用于正文，漫画名需单独选择。' : '供应商已保存，已提交的正文任务仍保持原版本。'); setEditing(undefined); void reload(false); requestAnimationFrame(() => document.getElementById('main')?.focus());}}/>}
  </main>;
}
