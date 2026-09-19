import {useEffect, useRef, useState} from 'react';
import {errorText, request} from './api';
import type {Node} from './types';
import {NodeConfigFields, parseConfig, type ConfigSchema} from './NodeConfigFields';

type Configuration = {version: number; name: string; enabled: boolean; config: Record<string, unknown>};

export function NodeConfigDialog({node, onClose, onSaved}: {node: Node | 'new'; onClose: () => void; onSaved: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pool = node !== 'new' && node.kind === 'control_pool' ? node.capabilities[0] : undefined;
  const [schema, setSchema] = useState<ConfigSchema>();
  const [editor, setEditor] = useState<'form' | 'text'>('form');
  const [name, setName] = useState(node === 'new' ? '' : node.name);
  const [resource, setResource] = useState(node === 'new' ? '' : node.resource_id);
  const [enabled, setEnabled] = useState(node === 'new' ? true : node.enabled);
  const [version, setVersion] = useState(0);
  const [config, setConfig] = useState('{}');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [credential, setCredential] = useState<{node_id: string; token: string}>();
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current!.showModal();
    return () => {if (opener?.isConnected) opener.focus();};
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError('');
    Promise.all([request<ConfigSchema>('/v1/admin/compute-nodes/config-schema', {signal: controller.signal}),
      node === 'new' ? Promise.resolve(null) : request<Configuration>(`/v1/admin/compute-nodes/${node.id}/config`, {signal: controller.signal})]).then(([metadata, value]) => {
      setSchema(metadata);
      if (value) {setName(value.name); setEnabled(value.enabled); setVersion(value.version);}
      setConfig(JSON.stringify(value?.config || metadata.defaults, null, 2)); setEditor('form'); setSaved(false);
    }).catch(e => {if (e.name !== 'AbortError') setError(errorText(e));})
      .finally(() => {if (!controller.signal.aborted) setBusy(false);});
    return () => controller.abort();
  }, [node, reload]);
  async function rotate() {
    if (node === 'new') return;
    setBusy(true); setError('');
    try {setCredential(await request(`/v1/admin/compute-nodes/${node.id}/rotate-credential`, {method: 'POST'})); onSaved();}
    catch (e) {setError(errorText(e));} finally {setBusy(false);}
  }
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="node-config-title">
    <div className="dialog-top"><h2 id="node-config-title">{node === 'new' ? '添加翻译节点' : pool ? '资源池配置' : '节点配置'}</h2><button className="secondary" onClick={onClose}>关闭 ×</button></div>
    <div className="dialog-content">
      {error && <p className="error" role="alert">{error}<button type="button" className="text-link" disabled={busy} onClick={() => setReload(v => v + 1)}>重新读取配置</button></p>}
      {busy && <p className="muted" role="status">正在处理配置…</p>}
      {credential ? <section className="panel credential"><h3>保存节点凭据</h3><p>密钥只在本次显示。将身份信息填写到该节点的本地配置文件。</p>
        <label>节点 ID<input readOnly value={credential.node_id}/></label><label>节点密钥<textarea readOnly rows={3} value={credential.token}/></label>
        <p className="muted">轮换后旧密钥立即失效；请更新节点文件并重启代理。</p><button className="primary" onClick={onClose}>已保存，关闭</button></section> :
        <form className="node-config-form" onSubmit={async event => {
          event.preventDefault(); setBusy(true); setError(''); setSaved(false);
          try {
            const parsed = parseConfig(config, schema!, pool);
            if (node === 'new') {
              setCredential(await request('/v1/admin/compute-nodes', {method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name, resource_id: resource, config: parsed})}));
            } else {
              const result = await request<Configuration>(`/v1/admin/compute-nodes/${node.id}/config`, {method: 'PUT', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name, enabled, config: parsed, expected_version: version})});
              setVersion(result.version); setConfig(JSON.stringify(result.config, null, 2)); setSaved(true);
            }
            onSaved();
          } catch (e) {setError(errorText(e));}
          finally {setBusy(false);}
        }}>
          <fieldset disabled={busy || !schema} className="config-body">
          <label>节点名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)}/></label>
          <label>节点资源 ID<input required pattern="[A-Za-z0-9_.:\-]+" maxLength={120} placeholder="machine-a:vulkan:0" value={resource} disabled={node !== 'new'} onChange={e => setResource(e.target.value)}/></label>
          {node !== 'new' && <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>允许领取新任务</label>}
          <div className="config-tabs" role="group" aria-label="配置编辑方式">{(['form', 'text'] as const).map(mode =>
            <button key={mode} type="button" aria-pressed={editor === mode} className={editor === mode ? 'primary' : 'secondary'} onClick={() => {
              if (mode === editor) return;
              try {setConfig(JSON.stringify(parseConfig(config, schema!, pool), null, 2)); setEditor(mode); setError('');}
              catch (e) {setError(errorText(e));}
            }}>{mode === 'form' ? '表单配置' : '文本配置（JSON）'}</button>)}</div>
          {editor === 'text' ? <label>服务端运行配置<textarea required rows={16} spellCheck={false} value={config} onChange={e => {setConfig(e.target.value); setSaved(false);}}/></label> :
            schema && <NodeConfigFields value={JSON.parse(config)} schema={schema} pool={pool} languages={node === 'new' ? [] : node.supported_languages}
              onChange={value => {setConfig(JSON.stringify(value, null, 2)); setSaved(false);}}/>}
          <p className="muted">{pool ? '保存后影响下一次任务领取；缩容或停用会等待已有阶段完成。所有控制工作进程共享此容量，重启保留设置。' : '执行位表示承接的整页数量，等待译文与交付也占位。缩容与停用只限制新领取；线程、设备和缓存由节点本地配置。'}</p>
          {saved && <p className="success" role="status">已保存版本 {version}，后续领取按新配置执行。</p>}
          <div className="node-actions"><button className="primary" disabled={busy || !schema || (node !== 'new' && !version)}>{busy ? '正在处理…' : node === 'new' ? '创建节点并生成密钥' : '保存配置'}</button>
            {node !== 'new' && !pool && <button type="button" className="secondary" disabled={busy} onClick={rotate}>轮换密钥（旧密钥立即失效）</button>}</div>
          </fieldset>
        </form>}
    </div>
  </dialog>;
}
