import {useRef, useState} from 'react';
import {authError, errorText, request} from './api';
import {billingEndpoint, environmentName, intervalName, minorAmount, money, priceAmount, providerName, type BillingChannel, type BillingEnvironment, type BillingPrice, type BillingProduct, type BillingProvider} from './billing';
import {BillingDialog} from './BillingShared';

export type CatalogEditor = {kind: 'product'} | {kind: 'benefits'; product: BillingProduct} | {kind: 'price'; product: BillingProduct; copy?: BillingPrice} | {kind: 'binding'; price: BillingPrice};
export function BillingCatalogForm({editor, channels, onClose, onSaved, onUnauthorized}: {editor: CatalogEditor; channels: BillingChannel[]; onClose: () => void; onSaved: (productId?: string) => Promise<void>; onUnauthorized: (message: string) => void}) {
  const product = 'product' in editor ? editor.product : undefined;
  const latest = product?.revisions.slice().sort((a, b) => b.version - a.version)[0];
  const copied = editor.kind === 'price' ? editor.copy : undefined;
  const [recordId] = useState(() => crypto.randomUUID());
  const [productId, setProductId] = useState('');
  const [benefits, setBenefits] = useState({name: latest?.name ?? '', monthly_redraw_pages: latest?.monthly_redraw_pages ?? 300, trial_days: latest?.trial_days ?? 7, trial_redraw_pages: latest?.trial_redraw_pages ?? 30});
  const [price, setPrice] = useState({plan_revision_id: copied?.plan_revision_id ?? latest?.id ?? '', currency: copied?.currency ?? 'usd', amount: copied ? priceAmount(copied.unit_amount, copied.currency) : '9.99', interval: copied?.interval ?? 'month', environment: copied?.environment ?? channels.find(channel => channel.enabled)?.environment ?? 'test'});
  const [binding, setBinding] = useState({provider: (channels.find(channel => channel.enabled)?.provider ?? 'creem') as BillingProvider, product_id: '', provider_price_id: '', trial_product_id: ''});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const title = editor.kind === 'product' ? '新建产品' : editor.kind === 'benefits' ? `更新 ${product!.name} 权益` : editor.kind === 'price' ? `${copied ? '复制' : '添加'} ${product!.name} 价格` : '关联支付渠道';
  const channel = channels.find(value => value.provider === binding.provider);
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      let path: string, body: unknown;
      if (editor.kind === 'product') {path = '/products'; body = {...benefits, id: productId, revision_id: recordId};}
      else if (editor.kind === 'benefits') {path = `/products/${encodeURIComponent(editor.product.id)}/revisions`; body = {...benefits, id: recordId};}
      else if (editor.kind === 'price') {path = '/prices'; body = {id: recordId, plan_revision_id: price.plan_revision_id, currency: price.currency, unit_amount: minorAmount(price.amount, price.currency), interval: price.interval, environment: price.environment};}
      else {path = `/prices/${encodeURIComponent(editor.price.id)}/bindings`; body = {id: recordId, provider: binding.provider, environment: editor.price.environment, product_id: binding.product_id.trim(), provider_price_id: binding.provider === 'stripe' ? binding.provider_price_id.trim() : null, trial_product_id: binding.provider === 'creem' && editor.price.trial_days > 0 ? binding.trial_product_id.trim() : null};}
      await request(billingEndpoint + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      await onSaved(editor.kind === 'product' ? productId : product?.id);
    } catch (failure) {
      if (authError(failure)) onUnauthorized(errorText(failure)); else setError(errorText(failure));
    } finally {pending.current = false; setBusy(false);}
  }
  return <BillingDialog title={title} busy={busy} onClose={onClose}><form className="billing-form" onSubmit={event => {event.preventDefault(); void submit();}}>
    <fieldset className="config-body" disabled={busy}>
      {(editor.kind === 'product' || editor.kind === 'benefits') && <><p className="muted">产品包含常规翻译不限量。月付与年付共用此产品权益，重绘额度每月发放。</p><div className="billing-form-grid">
        {editor.kind === 'product' && <label>产品编号<input required autoFocus pattern="[a-z][a-z0-9_-]*" maxLength={64} value={productId} placeholder="例如 plus" onChange={event => setProductId(event.target.value)}/><small>小写字母开头，可包含数字、短横线和下划线。</small></label>}
        <label>产品名称<input required maxLength={100} value={benefits.name} placeholder="例如 PLUS" onChange={event => setBenefits({...benefits, name: event.target.value})}/></label>
        <label>每月重绘页数<input required type="number" min={0} max={1000000} step={1} value={benefits.monthly_redraw_pages} onChange={event => setBenefits({...benefits, monthly_redraw_pages: Number(event.target.value)})}/></label>
        <label>首次试用天数<input required type="number" min={0} max={30} step={1} value={benefits.trial_days} onChange={event => setBenefits({...benefits, trial_days: Number(event.target.value), trial_redraw_pages: Number(event.target.value) === 0 ? 0 : benefits.trial_redraw_pages})}/></label>
        <label>试用重绘页数<input required type="number" min={0} max={1000000} step={1} disabled={!benefits.trial_days} value={benefits.trial_redraw_pages} onChange={event => setBenefits({...benefits, trial_redraw_pages: Number(event.target.value)})}/></label>
      </div>{editor.kind === 'benefits' && <p className="provider-warning">保存后请添加采用新权益的价格。现有价格和已购订阅继续保留原权益。</p>}</>}
      {editor.kind === 'price' && <><p className="muted">价格先保存为草稿，关联并验证支付渠道后发布。发布同一产品、环境、币种和周期的新价格，会自动停售原价格。</p><div className="billing-form-grid">
        <label>付款周期<select value={price.interval} onChange={event => {const interval = event.target.value as 'month' | 'year'; setPrice({...price, interval, amount: price.currency === 'usd' && ['9.99', '99.99'].includes(price.amount) ? interval === 'year' ? '99.99' : '9.99' : price.amount});}}><option value="month">月付</option><option value="year">年付（额度每月发放）</option></select></label>
        <label>币种<input required pattern="[a-zA-Z]{3}" maxLength={3} value={price.currency} onChange={event => setPrice({...price, currency: event.target.value.toLowerCase()})}/></label>
        <label>价格金额（{price.currency.toUpperCase()}）<input required inputMode="decimal" pattern="[0-9]+(\.[0-9]+)?" value={price.amount} onChange={event => setPrice({...price, amount: event.target.value})}/><small>填写实际金额，例如 9.99。</small></label>
        <label>支付环境<select value={price.environment} onChange={event => setPrice({...price, environment: event.target.value as BillingEnvironment})}><option value="test">测试环境</option><option value="live">正式环境</option></select></label>
        <label className="billing-form-wide">采用的产品权益<select required value={price.plan_revision_id} onChange={event => setPrice({...price, plan_revision_id: event.target.value})}>{editor.product.revisions.map(revision => <option key={revision.id} value={revision.id}>{revision.name} · {revision.monthly_redraw_pages} 页/月 · {revision.trial_days ? `${revision.trial_days} 天试用 / ${revision.trial_redraw_pages} 页` : '无试用'}{revision.id === latest?.id ? '（当前权益）' : '（历史权益）'}</option>)}</select></label>
      </div></>}
      {editor.kind === 'binding' && <><div className="billing-form-context"><strong>{editor.price.name} · {intervalName(editor.price.interval)} · {money(editor.price.unit_amount, editor.price.currency)}</strong><small>{environmentName(editor.price.environment)} · 首次试用 {editor.price.trial_days} 天</small></div><div className="billing-form-grid">
        <label className="billing-form-wide">支付渠道<select value={binding.provider} onChange={event => setBinding({...binding, provider: event.target.value as BillingProvider, product_id: '', provider_price_id: '', trial_product_id: ''})}>{channels.map(value => <option key={value.provider} value={value.provider}>{providerName(value.provider)}</option>)}</select></label>
        <label className="billing-form-wide">{binding.provider === 'creem' ? 'Creem 常规产品 ID（无试用）' : 'Stripe 产品 ID'}<input required autoComplete="off" maxLength={255} value={binding.product_id} onChange={event => setBinding({...binding, product_id: event.target.value})} placeholder={binding.provider === 'creem' ? 'prod_…' : 'prod_…'}/></label>
        {binding.provider === 'stripe' && <label className="billing-form-wide">Stripe 价格 ID<input required autoComplete="off" maxLength={255} value={binding.provider_price_id} onChange={event => setBinding({...binding, provider_price_id: event.target.value})} placeholder="price_…"/></label>}
        {binding.provider === 'creem' && editor.price.trial_days > 0 && <label className="billing-form-wide">Creem 首次试用产品 ID<input required autoComplete="off" maxLength={255} value={binding.trial_product_id} onChange={event => setBinding({...binding, trial_product_id: event.target.value})} placeholder="prod_…"/><small>在 Creem 创建同价、同币种、同周期且带 {editor.price.trial_days} 天试用的产品。已试用用户使用常规产品，避免重复试用。</small></label>}
      </div><p className="muted">平台产品的金额、币种和周期须与此价格一致。保存关联后，点击“验证并启用”检查平台配置。</p>{channel && (!channel.credential_configured || channel.environment !== editor.price.environment) && <p className="provider-warning">{!channel.credential_configured ? '渠道 API 密钥尚未配置。' : '渠道当前环境与此价格不一致。'}可先保存草稿，服务端配置完成后再验证启用。</p>}</>}
    </fieldset>
    {error && <div className="error" role="alert">{error} 结果不确定时先关闭并刷新列表核实；保留此表单重试不会重复创建。</div>}
    <div className="provider-save-bar"><small>已有订阅保留购买时的价格和权益。</small><div className="provider-actions"><button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? '正在保存…' : editor.kind === 'price' || editor.kind === 'binding' ? '保存草稿' : '保存产品'}</button></div></div>
  </form></BillingDialog>;
}
