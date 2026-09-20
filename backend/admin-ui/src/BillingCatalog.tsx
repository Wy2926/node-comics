import {useEffect, useRef, useState} from 'react';
import {authError, errorText, request} from './api';
import {billingEndpoint, environmentName, intervalName, money, providerName, type BillingCatalog, type BillingPrice, type BillingProduct} from './billing';
import {BillingBadge, useBillingResource} from './BillingShared';
import {BillingCatalogForm, type CatalogEditor} from './BillingCatalogForms';
import {Empty, Table} from './ui';

export function BillingCatalogPage({onUnauthorized}: {onUnauthorized: (message: string) => void}) {
  const {data, loading, error, reload} = useBillingResource<BillingCatalog>(billingEndpoint + '/catalog', onUnauthorized);
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<CatalogEditor>();
  const [pending, setPending] = useState('');
  const actionPending = useRef(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const blocked = loading || !!pending || !!error || !!actionError;
  const selected = data?.products.find(product => product.id === selectedId) ?? data?.products[0];
  const latest = selected?.revisions.slice().sort((a, b) => b.version - a.version)[0];
  useEffect(() => {document.title = '产品与价格 · Node Comics 管理后台';}, []);

  async function refresh() {setActionError(''); setNotice(''); await reload();}
  async function changeStatus(kind: 'prices' | 'bindings', id: string, active: boolean) {
    if (blocked || actionPending.current) return;
    actionPending.current = true; setPending(id); setActionError(''); setNotice('');
    try {
      await request(`${billingEndpoint}/${kind}/${encodeURIComponent(id)}/status`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({status: active ? 'archived' : 'active'})});
      setNotice(kind === 'prices' ? active ? '价格已停售，已有订阅保留原价格。' : '价格已发布，可通过已启用的支付渠道购买。' : active ? '此价格的支付渠道已停用。' : '支付渠道已验证并启用。');
      await reload();
    } catch (failure) {
      if (authError(failure)) onUnauthorized(errorText(failure)); else setActionError(errorText(failure));
    } finally {actionPending.current = false; setPending('');}
  }
  const edit = (value: CatalogEditor) => {setNotice(''); setEditor(value);};
  function priceCard(price: BillingPrice, product: BillingProduct) {
    return <article className="billing-price" key={price.id}>
      <div className="billing-price-heading"><div><div className="provider-name"><h3>{intervalName(price.interval)}</h3><BillingBadge status={price.status}/><span className="billing-environment">{environmentName(price.environment)}</span></div>
        <p className="billing-price-amount">{money(price.unit_amount, price.currency)} <small>/ {price.interval === 'year' ? '年' : '月'}</small></p>
        <p className="muted">每月 {price.monthly_redraw_pages} 页重绘{price.interval === 'year' && ' · 按月发放，不累积'}{price.trial_days > 0 && ` · 首次试用 ${price.trial_days} 天 / ${price.trial_redraw_pages} 页`}</p></div>
        <div className="provider-actions"><button className="secondary" disabled={blocked} onClick={() => edit({kind: 'price', product, copy: price})}>复制价格</button>
          <button className="secondary" disabled={blocked || (price.status !== 'active' && !price.bindings.some(binding => binding.status === 'active'))} onClick={() => void changeStatus('prices', price.id, price.status === 'active')}>{pending === price.id ? '正在保存…' : price.status === 'active' ? '停售价格' : '发布价格'}</button></div></div>
      <div className="billing-binding-heading"><h4>支付渠道</h4><button className="text-link" disabled={blocked} onClick={() => edit({kind: 'binding', price})}>＋ 关联支付渠道</button></div>
      {price.bindings.length ? <Table heads={['渠道', '平台产品与价格', '状态', '操作']}>{price.bindings.map(binding => <tr key={binding.id}>
        <td><b>{providerName(binding.provider)}</b><small>{environmentName(binding.environment)}</small></td>
        <td><code>{binding.product_id}</code>{binding.provider_price_id && <small>价格 <code>{binding.provider_price_id}</code></small>}{binding.trial_product_id && <small>试用产品 <code>{binding.trial_product_id}</code></small>}</td>
        <td><BillingBadge status={binding.status} binding/></td><td><button className="text-link" disabled={blocked} onClick={() => void changeStatus('bindings', binding.id, binding.status === 'active')}>{pending === binding.id ? '正在验证…' : binding.status === 'active' ? '停用渠道' : '验证并启用'}</button></td>
      </tr>)}</Table> : <p className="billing-no-bindings">关联 Stripe 或 Creem 平台产品，验证并启用渠道后即可发布价格。</p>}
      <details className="billing-price-meta"><summary>价格记录</summary><p>价格编号 <code>{price.id}</code></p><p>权益记录 {price.name} · 第 {price.version} 版</p></details>
    </article>;
  }
  return <main id="main" tabIndex={-1} className="billing-catalog">
    <div className="page-heading"><div><p className="eyebrow">PRODUCTS & PRICES</p><h1>产品与价格</h1><p className="muted">为套餐产品设置月付、年付价格，再关联可购买的支付渠道。</p></div>
      <div className="provider-actions"><button className="secondary" disabled={loading || !!pending} onClick={() => void refresh()}>{loading ? '正在刷新…' : '刷新列表'}</button><button className="primary" disabled={blocked || !data} onClick={() => edit({kind: 'product'})}>＋ 新建产品</button></div></div>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
    {(error || actionError) && <div className="error" role="alert">{error || actionError} {data && '当前列表可能已过时。'}请刷新核实最新状态后继续操作。</div>}
    {data && <section className="billing-channels" aria-label="支付渠道状态">{data.channels.map(channel => <article key={channel.provider} className="panel billing-channel"><div className="provider-name"><b>{providerName(channel.provider)}</b><span className={`badge ${channel.checkout_enabled ? 'good' : ''}`}>{channel.checkout_enabled ? '可结账' : '待配置'}</span></div><small>{environmentName(channel.environment)} · {channel.enabled ? '已启用' : '未启用'}</small>
      <p className="muted">API 密钥{channel.credential_configured ? '已配置' : '未配置'} · Webhook {channel.webhook_configured ? '已配置' : '未配置'}</p></article>)}</section>}
    {!data ? <section className="panel"><div className="loading" role="status">{loading ? '正在读取产品…' : '暂时无法读取产品，请刷新重试。'}</div></section> : !data.products.length ? <section className="panel"><Empty>尚未创建套餐产品</Empty></section> : <div className="billing-workspace" aria-busy={loading}>
      <aside className="panel billing-product-nav" aria-label="套餐产品"><h2>产品 <span>{data.products.length}</span></h2>{data.products.map(product => <button key={product.id} aria-pressed={selected?.id === product.id} onClick={() => setSelectedId(product.id)}><b>{product.name}</b><small>{product.prices.length} 个价格 · {product.prices.filter(price => price.status === 'active').length} 个在售</small></button>)}</aside>
      {selected && <section className="billing-product-detail" aria-label={`${selected.name} 产品详情`}><div className="panel billing-product-summary"><div className="billing-product-title"><div><p className="eyebrow">SUBSCRIPTION PRODUCT</p><h2>{selected.name}</h2><small>产品编号 {selected.id}</small></div><button className="secondary" disabled={blocked || !latest} onClick={() => edit({kind: 'benefits', product: selected})}>更新权益</button></div>
        {latest && <div className="billing-benefits"><span><strong>{latest.monthly_redraw_pages}</strong> 页重绘 / 月</span><span><strong>不限量</strong> 常规翻译</span><span><strong>{latest.trial_days || '无'}</strong> {latest.trial_days ? `天首次试用 · ${latest.trial_redraw_pages} 页` : '试用'}</span></div>}
        <p className="muted">月付与年付均每月发放重绘额度；更新权益用于后续创建的价格，已售订阅保留购买时的权益。</p></div>
        <div className="billing-prices-title"><h2>价格</h2><button className="primary" disabled={blocked || !latest} onClick={() => edit({kind: 'price', product: selected})}>＋ 添加价格</button></div>
        {!selected.prices.length ? <section className="panel"><Empty>为此产品添加月付或年付价格</Empty></section> : <div className="billing-prices">{selected.prices.map(price => priceCard(price, selected))}</div>}
      </section>}
    </div>}
    {data && <p className="footnote billing-footnote">价格发布前验证支付平台的产品、金额、币种和付款周期。停售仅关闭新购买入口；已有订阅仍按原合同续费。</p>}
    {editor && data && <BillingCatalogForm key={editor.kind + ('price' in editor ? editor.price.id : 'product' in editor ? editor.product.id : '')} editor={editor} channels={data.channels} onUnauthorized={onUnauthorized} onClose={() => setEditor(undefined)} onSaved={async id => {setEditor(undefined); setActionError(''); if (id) setSelectedId(id); setNotice('已保存。价格和支付渠道的最新状态以列表为准。'); await reload();}}/>}
  </main>;
}
