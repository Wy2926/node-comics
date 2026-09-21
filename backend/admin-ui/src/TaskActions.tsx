import {useRef, useState} from 'react';
import {ApiError, authError, errorText, request} from './api';

type Job = {id: string; status: string; settlement: string; quota_pages: number; cancel_requested?: boolean; discard_output?: boolean};
type Operation = {kind: 'failed' | 'existing' | 'upload'; note: string; output_asset_id?: string; image_hash?: string; file_name?: string};
export async function imageHash(file: File) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function TaskActions({job, onChanged, onUnauthorized}: {job: Job; onChanged: () => void; onUnauthorized?: (message: string) => void}) {
  // The session namespace is cleared when the administrator changes identity.
  // Only operation metadata is kept; image bytes remain in the file picker.
  const storageKey = `nc-admin-benefit:job-reconcile:${job.id}`;
  const [operation, setOperation] = useState<Operation | undefined>(() => {
    try {return JSON.parse(sessionStorage.getItem(storageKey) || 'null') || undefined;} catch {return undefined;}
  });
  const [kind, setKind] = useState<Operation['kind']>('failed'), [note, setNote] = useState(''), [assetId, setAssetId] = useState('');
  const [file, setFile] = useState<File>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lock = useRef(false);
  const unknown = ['outcome_unknown', 'unknown_released'].includes(job.status);
  const mayDeliver = !job.cancel_requested && !job.discard_output;
  function save(value?: Operation) {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey);
    setOperation(value);
  }
  async function submit() {
    // A server-side commit may have succeeded before the response was lost.
    // Terminal tasks may recover the persisted request, never start a new one.
    if (lock.current || (!unknown && !operation)) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      let current = operation;
      if (!current) {
        if (!note.trim()) throw Error('请填写向供应商核实的依据与处理备注。');
        if (kind === 'existing' && !assetId.trim()) throw Error('请填写属于任务原用户的结果图片 ID。');
        if (kind === 'upload' && !file) throw Error('请选择供应商已经生成的译图。');
        current = {kind, note: note.trim(), ...(kind === 'existing' ? {output_asset_id: assetId.trim()} : {}),
          ...(kind === 'upload' && file ? {image_hash: await imageHash(file), file_name: file.name} : {})};
        save(current);
      }
      const path = `/v1/admin/jobs/${encodeURIComponent(job.id)}/reconcile`;
      if (current.kind === 'upload') {
        if (!file || await imageHash(file) !== current.image_hash) throw Error(`请选择原补交文件「${current.file_name}」，恢复相同操作。`);
        const body = new FormData(); body.set('image', file); body.set('note', current.note);
        await request(`${path}-image`, {method: 'POST', body});
      } else {
        await request(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
          resolution: current.kind === 'failed' ? 'failed' : 'succeeded', note: current.note,
          ...(current.output_asset_id ? {output_asset_id: current.output_asset_id} : {}),
        })});
      }
      save(); setNotice('核实已完成，任务与额度状态已更新。'); onChanged();
    } catch (failure) {
      if (authError(failure) && onUnauthorized) onUnauthorized(errorText(failure));
      else setError(errorText(failure));
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) save();
    } finally {lock.current = false; setBusy(false);}
  }
  if (!unknown && !operation) return <>{notice && <p className="settings-notice" role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}</>;
  return <section className="panel membership-actions" aria-labelledby="task-resolution-title">
    <h3 id="task-resolution-title">核实供应商结果</h3>
    <p className="muted">先通过供应商请求编号确认结果，再记录结论或补交已生成译图。此操作不重新调用图片模型。</p>
    <p className="attention">{!unknown ? '任务状态已经更新。本次仅核对原操作回执，不能修改已完成的结论或译图。' : job.settlement === 'reserved' ? `确认成功将结算已预占的 ${job.quota_pages} 页；确认失败将释放预占。` :
      '此任务已无额度预占，补交迟到结果不会再次扣页。'}{unknown && !mayDeliver && ' 用户已取消或删除，仅能确认失败。'}</p>
    {operation ? <>
      <p>待恢复操作：{({failed: '确认失败', existing: '关联已有结果', upload: '补交译图'})[operation.kind]} · {operation.note}</p>
      <p className="panel-note">提交结果尚未确认。恢复时会核对原结论、备注和图片，重复请求不会重复结算。</p>
      {operation.kind === 'upload' && <label>重新选择原补交文件<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => setFile(event.target.files?.[0])}/></label>}
      <button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? '正在核实…' : '恢复原核实操作'}</button>
      <button className="secondary" disabled={busy} onClick={onChanged}>刷新任务状态</button>
    </> : <form onSubmit={event => {event.preventDefault(); void submit();}}>
      <fieldset className="benefit-fields" disabled={busy}>
        <label>核实结论<select value={kind} onChange={event => setKind(event.target.value as Operation['kind'])}>
          <option value="failed">供应商已确认失败</option><option value="existing" disabled={!mayDeliver}>关联已有结果图片</option><option value="upload" disabled={!mayDeliver}>补交供应商译图</option>
        </select></label>
        {kind === 'existing' && <label>结果图片 ID<input required value={assetId} onChange={event => setAssetId(event.target.value)} placeholder="必须属于任务原用户且未关联其他任务"/></label>}
        {kind === 'upload' && <label>已有译图<input type="file" required accept="image/png,image/jpeg,image/webp" onChange={event => setFile(event.target.files?.[0])}/></label>}
        <label>核实依据与备注<input required maxLength={200} value={note} onChange={event => setNote(event.target.value)} placeholder="例如供应商工单编号、查询结论与处理原因"/></label>
        <button className="primary" disabled={!note.trim() || (kind !== 'failed' && !mayDeliver)}>{busy ? '正在核实…' : '记录核实结论'}</button>
      </fieldset>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="settings-notice" role="status">{notice}</p>}
  </section>;
}
