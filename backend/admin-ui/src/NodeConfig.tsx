import {useEffect, useRef, useState} from 'react';
import {ApiError, errorText, request} from './api';
import type {Node} from './types';

type Configuration = {version: number; name: string; enabled: boolean; config: Record<string, unknown>};
const initial = {schema_version: 1, execution_slots: 1, poll_seconds: 1, heartbeat_seconds: 10,
  config_poll_seconds: 15, request_seconds: 30, stage_seconds: 900,
  input_cache_bytes: 134217728, input_cache_ttl_seconds: 900, engine: {}};

export function NodeConfigDialog({node, onClose, onSaved}: {node: Node | 'new'; onClose: () => void; onSaved: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(node === 'new' ? '' : node.name);
  const [resource, setResource] = useState(node === 'new' ? '' : node.resource_id);
  const [enabled, setEnabled] = useState(node === 'new' ? true : node.enabled);
  const [version, setVersion] = useState(0);
  const [config, setConfig] = useState(JSON.stringify(initial, null, 2));
  const [busy, setBusy] = useState(node !== 'new');
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
    if (node === 'new') return;
    const controller = new AbortController(); setBusy(true); setError('');
    request<Configuration>(`/v1/admin/compute-nodes/${node.id}/config`, {signal: controller.signal}).then(value => {
      setName(value.name); setEnabled(value.enabled); setVersion(value.version); setConfig(JSON.stringify(value.config, null, 2));
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
    <div className="dialog-top"><h2 id="node-config-title">{node === 'new' ? '添加翻译节点' : '节点配置'}</h2><button className="secondary" onClick={onClose}>关闭 ×</button></div>
    <div className="dialog-content">
      {error && <p className="error" role="alert">{error}{node !== 'new' && <button className="text-link" onClick={() => setReload(v => v + 1)}>重新读取配置</button>}</p>}
      {credential ? <section className="panel credential"><h3>保存节点凭据</h3><p>密钥只在本次显示。将身份信息填写到该节点的本地配置文件。</p>
        <label>节点 ID<input readOnly value={credential.node_id}/></label><label>节点密钥<textarea readOnly rows={3} value={credential.token}/></label>
        <p className="muted">轮换后旧密钥立即失效；请更新节点文件并重启代理。</p><button className="primary" onClick={onClose}>已保存，关闭</button></section> :
        <form className="node-config-form" onSubmit={async event => {
          event.preventDefault(); setBusy(true); setError(''); setSaved(false);
          try {
            const parsed = JSON.parse(config);
            if (node === 'new') {
              setCredential(await request('/v1/admin/compute-nodes', {method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name, resource_id: resource, config: parsed})}));
            } else {
              const result = await request<Configuration>(`/v1/admin/compute-nodes/${node.id}/config`, {method: 'PUT', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name, enabled, config: parsed, expected_version: version})});
              setVersion(result.version); setConfig(JSON.stringify(result.config, null, 2)); setSaved(true);
            }
            onSaved();
          } catch (e) {setError(e instanceof SyntaxError ? '配置 JSON 格式不正确，请检查后重试。' : e instanceof ApiError && e.status === 422 ? '节点配置无效：执行位须为 1–32 的整数，请检查线程数、语言和心跳范围。' : errorText(e));}
          finally {setBusy(false);}
        }}>
          <label>节点名称<input required maxLength={120} value={name} onChange={e => setName(e.target.value)}/></label>
          <label>物理资源 ID<input required pattern="[A-Za-z0-9_.:\-]+" maxLength={120} placeholder="machine-a:cuda:0" value={resource} disabled={node !== 'new'} onChange={e => setResource(e.target.value)}/></label>
          {node !== 'new' && <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>允许领取新任务</label>}
          <label>服务端运行配置<textarea required rows={12} spellCheck={false} value={config} onChange={e => setConfig(e.target.value)}/></label>
          <p className="muted">execution_slots 设置同时在途的阶段数；engine 可覆盖 languages、torch_threads、opencv_threads、cache_bytes、cache_ttl_seconds。留空使用节点本地文件设置。</p>
          <p className="muted">节点定期拉取配置，等待当前阶段完成后应用。单 GPU 引擎安全串行执行模型，增加执行位不代表 GPU 并行加速。</p>
          {saved && <p className="success" role="status">已保存版本 {version}，等待节点应用。</p>}
          <div className="node-actions"><button className="primary" disabled={busy || (node !== 'new' && !version)}>{busy ? '正在处理…' : node === 'new' ? '创建节点并生成密钥' : '保存配置'}</button>
            {node !== 'new' && <button type="button" className="secondary" disabled={busy} onClick={rotate}>轮换密钥（旧密钥立即失效）</button>}</div>
        </form>}
    </div>
  </dialog>;
}
