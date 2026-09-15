import {useState} from 'react';
import type {Api} from '../api';
import type {Entitlements} from '../types';
export type AdminUser={id:string;name:string;role:string;entitlements:Entitlements};

export function MembershipControls({api,users,onChanged}:{api:Api;users:AdminUser[];onChanged:()=>Promise<void>}) {
  const [target,setTarget]=useState(''),[months,setMonths]=useState(1),[pages,setPages]=useState(10);
  const [kind,setKind]=useState('classic_daily'),[note,setNote]=useState(''),[operation,setOperation]=useState('extend');
  const [key,setKey]=useState(()=>crypto.randomUUID()),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const changed=()=>{setKey(crypto.randomUUID());setMessage('');};
  async function submit(){
    if(busy||!target||!note.trim())return;
    setBusy(true);setError('');
    try{
      const compensation=operation==='compensate';
      await api.request(`/v1/admin/users/${target}/${compensation?'quota-compensations':'membership'}`,{
        method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(compensation?{kind,pages,note}:{action:operation,months,note})});
      if(api.isCurrent()){setMessage('操作已记录；相同操作编号重试不会重复发放。');await onChanged();}
    }catch(e){if(api.isCurrent())setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <>
    <section className="settings-card"><h3>用户与会员权益</h3>{users.map(user=><div className="setting-row" key={user.id}><div><b>{user.name} · {user.entitlements.plan==='plus'?'PLUS':'普通用户'} · {user.role}</b><p>常规：{user.entitlements.modes.classic.unlimited?'不限量':`${user.entitlements.modes.classic.quota?.available??0} 页可用`} · 重绘：{user.entitlements.modes.redraw.quota?.available??0} 页可用 · 每模式 {user.entitlements.queue_capacity} 页 · 实时 {user.entitlements.realtime_slots} 页 · 调度权重 {user.entitlements.scheduler_weight}</p></div><button className="button secondary small" onClick={()=>{setTarget(user.id);changed();setNote('');}}>管理会员与额度</button></div>)}</section>
    {target&&<section className="settings-card"><h3>{users.find(u=>u.id===target)?.name??target}</h3>
      <label className="field">操作<select aria-label="会员管理操作" value={operation} disabled={busy} onChange={e=>{setOperation(e.target.value);changed();}}><option value="extend">开通或续期 PLUS</option><option value="expire">立即结束 PLUS</option><option value="compensate">补偿当前周期额度</option></select></label>
      {operation==='extend'&&<label className="field">会员月数<input aria-label="会员月数" type="number" min={1} max={120} value={months} disabled={busy} onChange={e=>{setMonths(Number(e.target.value));changed();}}/></label>}
      {operation==='compensate'&&<><label className="field">额度类型<select value={kind} disabled={busy} onChange={e=>{setKind(e.target.value);changed();}}><option value="classic_daily">常规每日额度</option><option value="redraw_monthly">PLUS 月重绘额度</option></select></label><label className="field">补偿页数<input type="number" min={1} max={1000000} value={pages} disabled={busy} onChange={e=>{setPages(Number(e.target.value));changed();}}/></label></>}
      <p className="nc-muted">{operation==='extend'?'开通采用后端配置的月重绘页数；续期保留现有会员段的额度规则，逐月发放。':operation==='expire'?'立即停止新任务的 PLUS 权益，已受理任务继续按原权益完成。':'补偿沿用当前额度周期，到期不累积。'}</p>
      <label className="field">操作备注<input maxLength={200} value={note} disabled={busy} onChange={e=>{setNote(e.target.value);changed();}}/></label>
      <button className="button primary" disabled={busy||!note.trim()||(operation==='extend'&&(!Number.isInteger(months)||months<1||months>120))||(operation==='compensate'&&(!Number.isInteger(pages)||pages<1))} onClick={()=>void submit()}>确认操作</button>
      {error&&<p className="inline-error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    </section>}
  </>;
}
