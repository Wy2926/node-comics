import {useCallback, useEffect, useRef, useState} from 'react';
import {authError, errorText, request} from './api';

type Revision={id:string;plan_id:string;version:number;name:string;monthly_redraw_pages:number;trial_days:number;trial_redraw_pages:number};
type Price=Revision&{plan_revision_id:string;currency:string;unit_amount:number;interval:'month'|'year';environment:string;status:'draft'|'active'|'archived';stripe_product_id:string|null;stripe_price_id:string|null};
type Catalog={plans:{id:string;name:string}[];revisions:Revision[];prices:Price[]};
const endpoint='/v1/admin/billing';

export function BillingCatalogPage({onUnauthorized}:{onUnauthorized:(message:string)=>void}){
  const [data,setData]=useState<Catalog>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const pending=useRef(false);
  const [revisionId,setRevisionId]=useState(()=>crypto.randomUUID());
  const [priceId,setPriceId]=useState(()=>crypto.randomUUID());
  const [revision,setRevision]=useState({plan_id:'',name:'',monthly_redraw_pages:300,trial_days:7,trial_redraw_pages:30});
  const [price,setPrice]=useState({plan_revision_id:'',currency:'usd',unit_amount:999,interval:'month',stripe_product_id:'',stripe_price_id:''});
  const load=useCallback(async()=>{setData(await request<Catalog>(endpoint+'/catalog'));},[]);
  const failure=useCallback((e:unknown)=>{if(authError(e))onUnauthorized(errorText(e));else setError(errorText(e));},[onUnauthorized]);
  useEffect(()=>{document.title='订阅套餐 · Node Comics 管理后台';void load().catch(failure);},[load,failure]);
  async function act(path:string,body:unknown,done:()=>void,method='POST'){
    if(pending.current)return;
    pending.current=true;setBusy(true);setError('');setNotice('');
    try{
      await request(endpoint+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      done();await load();setNotice('已保存。已有订阅继续使用原价格和权益版本。');
    }catch(e){failure(e);}finally{pending.current=false;setBusy(false);}
  }
  return <main id="main" tabIndex={-1}>
    <div className="page-heading"><div><p className="eyebrow">SUBSCRIPTION CATALOG</p><h1>订阅套餐</h1><p className="muted">套餐权益和报价分别版本化。年付一次收款，重绘额度按月生效，不累积。</p></div>
      <button className="secondary" disabled={busy} onClick={()=>{setError('');void load().catch(failure);}}>刷新列表</button></div>
    {error&&<p className="error" role="alert">{error} 操作结果不确定时先刷新核实；相同编号重试不会重复创建。</p>}
    {notice&&<p role="status">{notice}</p>}
    {!data?<p role="status">正在读取套餐…</p>:<>
      <section className="panel"><h2>报价</h2><p className="muted">新报价默认草稿。发布前核验 Stripe 的金额、币种、周期与产品；同套餐、币种和周期的原报价自动停售。停售不影响续费或已发出的结账。</p>
        <div className="table-scroll"><table><thead><tr><th>套餐 / 权益版本</th><th>价格</th><th>每月重绘</th><th>试用</th><th>状态</th><th>操作</th></tr></thead><tbody>
          {data.prices.map(p=><tr key={p.id}><td>{p.name} v{p.version}<small className="muted"> {p.environment}</small></td><td>{p.currency.toUpperCase()} {p.unit_amount} 最小货币单位 / {p.interval==='year'?'年':'月'}</td><td>{p.monthly_redraw_pages} 页</td><td>{p.trial_days} 天 / {p.trial_redraw_pages} 页</td><td>{{draft:'草稿',active:'在售',archived:'停售'}[p.status]}</td><td>
            <button className="secondary" disabled={busy} onClick={()=>{setPriceId(crypto.randomUUID());setPrice({plan_revision_id:p.plan_revision_id,currency:p.currency,unit_amount:p.unit_amount,interval:p.interval,stripe_product_id:p.stripe_product_id??'',stripe_price_id:''});}}>复制为新报价</button>{' '}
            <button className="secondary" disabled={busy||(p.status!=='active'&&!p.stripe_price_id)} onClick={()=>void act(`/prices/${encodeURIComponent(p.id)}/status`,{status:p.status==='active'?'archived':'active'},()=>{},'PUT')}>{p.status==='active'?'停售':'发布'}</button>
          </td></tr>)}
        </tbody></table></div>
      </section>
      <section className="panel"><h2>创建套餐或权益版本</h2><p className="muted">同一套餐编号新增版本；已有版本保持不变。所有付费套餐均含常规翻译不限量及 PLUS 准入档位。</p>
        <form className="filter-form" onSubmit={e=>{e.preventDefault();void act(`/plans/${encodeURIComponent(revision.plan_id)}/revisions`,{id:revisionId,name:revision.name,monthly_redraw_pages:revision.monthly_redraw_pages,trial_days:revision.trial_days,trial_redraw_pages:revision.trial_redraw_pages},()=>setRevisionId(crypto.randomUUID()));}}>
          <label>套餐编号<input required pattern="[a-z][a-z0-9_-]*" maxLength={64} value={revision.plan_id} onChange={e=>setRevision({...revision,plan_id:e.target.value})} list="billing-plans"/></label><datalist id="billing-plans">{data.plans.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
          <label>显示名称<input required maxLength={100} value={revision.name} onChange={e=>setRevision({...revision,name:e.target.value})}/></label>
          <label>每月重绘页数<input required type="number" min={0} max={1000000} value={revision.monthly_redraw_pages} onChange={e=>setRevision({...revision,monthly_redraw_pages:Number(e.target.value)})}/></label>
          <label>首次试用天数<input required type="number" min={0} max={30} value={revision.trial_days} onChange={e=>setRevision({...revision,trial_days:Number(e.target.value),trial_redraw_pages:Number(e.target.value)===0?0:revision.trial_redraw_pages})}/></label>
          <label>试用重绘页数<input required type="number" min={0} max={1000000} disabled={revision.trial_days===0} value={revision.trial_redraw_pages} onChange={e=>setRevision({...revision,trial_redraw_pages:Number(e.target.value)})}/></label>
          <button className="primary" disabled={busy}>保存新版本</button>
        </form>
      </section>
      <section className="panel"><h2>创建报价</h2><p className="muted">金额填写币种的最小货币单位，例如 USD 999 表示 US$9.99。暂不售卖可留空 Stripe 编号。调价时创建新的 Stripe Price，并在这里创建新报价。</p>
        <form className="filter-form" onSubmit={e=>{e.preventDefault();void act('/prices',{...price,id:priceId,stripe_product_id:price.stripe_product_id||null,stripe_price_id:price.stripe_price_id||null},()=>setPriceId(crypto.randomUUID()));}}>
          <label>套餐权益版本<select required value={price.plan_revision_id} onChange={e=>setPrice({...price,plan_revision_id:e.target.value})}><option value="">请选择</option>{data.revisions.map(r=><option key={r.id} value={r.id}>{r.name} ({r.plan_id}) v{r.version} · {r.monthly_redraw_pages} 页/月</option>)}</select></label>
          <label>付款周期<select value={price.interval} onChange={e=>setPrice({...price,interval:e.target.value})}><option value="month">月付</option><option value="year">年付（每月发放额度）</option></select></label>
          <label>币种<input required pattern="[a-z]{3}" maxLength={3} value={price.currency} onChange={e=>setPrice({...price,currency:e.target.value.toLowerCase()})}/></label>
          <label>金额（最小货币单位）<input required type="number" min={1} max={100000000} value={price.unit_amount} onChange={e=>setPrice({...price,unit_amount:Number(e.target.value)})}/></label>
          <label>Stripe 产品 ID<input value={price.stripe_product_id} onChange={e=>setPrice({...price,stripe_product_id:e.target.value.trim()})}/></label>
          <label>Stripe 价格 ID<input value={price.stripe_price_id} onChange={e=>setPrice({...price,stripe_price_id:e.target.value.trim()})}/></label>
          <button className="primary" disabled={busy}>保存草稿报价</button>
        </form>
      </section>
    </>}
  </main>;
}
