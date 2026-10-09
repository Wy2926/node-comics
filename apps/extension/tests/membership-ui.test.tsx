import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Api} from '../src/api';
import type {Session} from '../src/auth/model';
import type {BillingCheckout,BillingOffer,BillingStatus} from '../src/billing';
import type {Entitlements,UsageSummary} from '../src/types';
import {installDictionary} from '../src/i18n/runtime';
import {AccountPage} from '../src/ui/Account';
import {EntitlementCards} from '../src/ui/Entitlements';
import {MembershipCard} from '../src/ui/MembershipCard';
import {AccountUsage} from '../src/ui/Usage';
import {billingOffer} from './billing-fixture-data';

// Render the loaded API snapshot without running browser effects or making requests.
// Subsequent state (errors and management controls) keeps its ordinary initial value.
const view=vi.hoisted(()=>({states:undefined as unknown[]|undefined}));
vi.mock('react',async importOriginal=>{
  const react=await importOriginal<typeof import('react')>();
  return {...react,useState:(initial:unknown)=>react.useState(view.states?.length?view.states.shift():initial)};
});
beforeEach(()=>{installDictionary('zh-CN',{});view.states=undefined;});
afterEach(()=>{view.states=undefined;});
const noop=()=>{};
const api=new Api('https://membership.fixture.test','synthetic');
const rights=(plan:Entitlements['plan']='lite'):Entitlements=>({
  plan,plus_started_at:null,plus_expires_at:null,timezone:'UTC',generated_at:'2026-10-02',pending_previous_period_pages:0,
  image_rate_limit:{limit:37,window_seconds:60},hourly_image_rate_limit:{limit:741,window_seconds:3600},
  modes:{classic:{allowed:true,unlimited:plan!=='free',quota_kind:plan==='free'?'classic_daily':'classic_unlimited',consent_version:'fixture',quota:null}},
});
const status=(extra:Partial<BillingStatus>={}):BillingStatus=>({
  enabled:true,offers:[billingOffer],providers:[{id:'creem',label:'Creem',environment:'test'}],provider:null,
  environment:'test',trial_eligible:true,subscription_checkout:null,
  entitlement_expires_at:null,gift:null,subscription:null,...extra,
});
const pack={...billingOffer,id:'pack-100',plan_id:'pages',interval:'once' as const,quota_pages:100,quota_validity_days:null,service_plan_id:'lite',trial_days:0};
const checkout=(price:BillingOffer,provider:BillingCheckout['provider']='creem'):BillingCheckout=>({
  id:'checkout-'+price.id,provider,price,idempotency_key:null,error:null,
});
function membership(billing:BillingStatus){
  view.states=[billing];
  return renderToStaticMarkup(<MembershipCard api={api} loggedIn rights={rights()} onEntitlements={noop} notify={noop}/>);
}

it('shows the returned minute and hourly limits without hardcoded membership allowances',()=>{
  const html=renderToStaticMarkup(<EntitlementCards data={rights()}/>);
  expect(html).toContain('<strong>37<small>张 / 60 秒</small>');
  expect(html).toContain('<strong>741<small>张 / 3600 秒</small>');
  expect(html).toContain('常规翻译不设日／月累计上限');
  expect(html.match(/class="nc-rights-card /g)).toHaveLength(2);
  expect(html).not.toMatch(/重绘|1200|PLUS/);
});

it('does not invent an hourly allowance when the API omits that field',()=>{
  const data=rights();delete data.hourly_image_rate_limit;
  const html=renderToStaticMarkup(<EntitlementCards data={data}/>);
  expect(html).toContain('<strong>37<small>');
  expect(html).not.toMatch(/3600|741|1200/);
});

it.each([[2,5,false],[0,0,false],[0,0,true]] as const)('separates free %i and subscription %i pages without treating free models as unmetered', (free,subscription,unlimited)=>{
  const balance=(available:number)=>({granted:available,used:0,reserved:0,available,next_expiry_at:null});
  const data={...rights(),free_quota:balance(free),subscription_quota:{...balance(subscription),unlimited},purchase_quota:balance(0)};
  const html=renderToStaticMarkup(<EntitlementCards data={data}/>);
  const cards=html.split('<article').slice(1);
  expect(cards).toHaveLength(4);
  const freeCard=cards.find(card=>card.includes('免费额度</div>'))!;
  const subscriptionCard=cards.find(card=>card.includes('订阅额度</div>'))!;
  expect(freeCard).toContain(`<strong>${free}<small>页可用</small>`);
  expect(freeCard).not.toContain('不限量');
  expect(subscriptionCard).toContain(unlimited?'<strong>不限量</strong>':`<strong>${subscription}<small>页可用</small>`);
  expect(html).toContain('免费模型先扣免费额度，用完后扣订阅额度，再扣购买额度；高级模型不能扣免费额度。');
});

it('identifies Lite as a member and keeps existing paid accounts out of the free badge',()=>{
  const account:Session={id:'fixture',token:'synthetic',expiresAt:1,refreshAt:0,credential:{kind:'development'},apiOrigin:api.base,user:{id:'fixture',name:'Reader',role:'reader'}};
  for(const [plan,label] of [['lite','Lite 会员'],['plus','会员'],['free','普通用户']] as const){
    const html=renderToStaticMarkup(<AccountPage api={api} account={account} rights={rights(plan)} testing={false} tab="subscription" onTabChange={noop} onLogin={noop} onLogout={noop} onEntitlements={noop} notify={noop}/>);
    const badge=html.match(/<span class="nc-plan-badge">(.*?)<\/span>/)?.[1];
    expect(badge).toContain(label);
    if(plan!=='free')expect(badge).not.toContain('普通用户');
  }
});

it('routes all new purchases to pricing without duplicating live quotes or checkout controls',()=>{
  const legacy={...billingOffer,id:'legacy-price',plan_id:'plus',name:'PLUS',unit_amount:999};
  const lite={...billingOffer,hourly_image_limit:741};
  const html=membership(status({offers:[legacy,lite]}));
  expect(html).toContain('前往定价页面');
  expect(html).toContain('href="https://comics.nodelane.net/pricing/"');
  expect(html).not.toMatch(/US\$|首次试用|付款周期|PLUS|每滚动小时/);
});

it('keeps the original subscription name and price for managing an existing paid contract',()=>{
  const price={...billingOffer,id:'legacy-contract',plan_id:'plus',name:'Existing subscription',unit_amount:999,hourly_image_limit:null};
  const html=membership(status({trial_eligible:false,subscription:{provider:'creem',price,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,paid_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null}}));
  expect(html).toContain('NODELANE COMICS Existing subscription');
  expect(html).toContain('US$9.99');
  expect(html).toContain('管理订阅');
  expect(html).not.toMatch(/每滚动小时|重绘|首次试用/);
});

it('does not force a pending subscription onto the shared pricing destination',()=>{
  const pending={...billingOffer,id:'original-price',plan_id:'plus',name:'Original quote',unit_amount:799};
  const html=membership(status({subscription_checkout:checkout(pending)}));
  expect(html).toContain('href="https://comics.nodelane.net/pricing/"');
  expect(html).toContain('前往定价页面');
  expect(html).not.toMatch(/Original quote|US\$/);
});

it('keeps subscription management while using the same pricing link for buying page packs',()=>{
  const html=membership(status({quota_offers:[pack],trial_eligible:false,subscription:{provider:'creem',price:billingOffer,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,paid_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null}}));
  expect(html).toContain('管理订阅');
  expect(html).toContain('href="https://comics.nodelane.net/pricing/"');
  expect(html).not.toMatch(/100 页常规翻译|aria-label="购买额度"|首次试用/);
});

it('leaves each page pack selection to the website without selecting a quote in navigation',()=>{
  const expiring={...pack,name:'Expiring page pack',quota_validity_days:30};
  const html=membership(status({quota_offers:[pack,expiring]}));
  expect(html).toContain('href="https://comics.nodelane.net/pricing/"');
  expect(html).not.toMatch(/Expiring page pack|30 天内有效|不限|按月自动续费|首次试用/);
});

it('keeps pending subscription independent of page packs and current service rights',()=>{
  const data={...rights('free'),service_plan:'lite',purchase_quota:{granted:100,used:10,reserved:1,available:89,next_expiry_at:null}};
  const render=(billing:BillingStatus)=>{
    view.states=[billing];
    return renderToStaticMarkup(<><MembershipCard api={api} loggedIn rights={data} onEntitlements={noop} notify={noop}/><EntitlementCards data={data}/></>);
  };
  const pending=status({subscription_checkout:checkout({...billingOffer,id:'pending-month'},'stripe'),quota_offers:[pack]});
  const html=render(pending);
  expect(html).toBe(render(status()));
  expect(html).toContain('href="https://comics.nodelane.net/pricing/"');
  expect(html).toContain('购买额度剩余 89 页 · 处理中 1 页');
  expect(html).toContain('当前服务档位：lite');
  expect(html).not.toMatch(/\?price=|pending-month|pack-100|checkout-|purchase-/);
});

it('offers the same pricing destination when signed out, without reading a private catalog',()=>{
  const html=renderToStaticMarkup(<MembershipCard api={api} loggedIn={false} onEntitlements={noop} notify={noop}/>);
  expect(html).toContain('href="https://comics.nodelane.net/pricing/"');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).not.toMatch(/US\$|首次试用|付款周期|重新购买/);
});

it('keeps membership identity, effective service and purchased balance independent',()=>{
  const data={...rights('free'),service_plan:'lite',purchase_quota:{granted:100,used:10,reserved:1,available:89,next_expiry_at:null}};
  let html=renderToStaticMarkup(<EntitlementCards data={data}/>);
  expect(html).toContain('购买额度剩余 89 页 · 处理中 1 页');
  expect(html).toContain('当前服务档位：lite');
  expect(html).not.toContain('不限量');
  html=renderToStaticMarkup(<EntitlementCards data={{...data,...rights('lite')}}/>);
  expect(html).toContain('不限量');
  expect(html).toContain('购买额度剩余 89 页');
  html=renderToStaticMarkup(<EntitlementCards data={{...data,service_plan:'free',purchase_quota:{...data.purchase_quota,used:100,reserved:0,available:0}}}/>);
  expect(html).toContain('购买额度剩余 0 页');
  expect(html).toContain('当前服务档位：普通用户');
  expect(html).not.toMatch(/不限量|不过期/);
});

it('uses the server totals and daily totals without rebuilding them from one mode',()=>{
  const data:UsageSummary={entitlements:rights(),timezone:'UTC',start_date:'2026-10-01',end_date:'2026-10-02',generated_at:'2026-10-02',delivered:42,free_delivered:3,included_delivered:11,by_mode:{classic:20},quota_used:{classic:9},days:[{date:'2026-10-01',classic:7,delivered:17}]};
  view.states=[7,data];
  const html=renderToStaticMarkup(<AccountUsage api={api} onLogin={noop} onEntitlements={noop}/>);
  expect(html).toContain('<b>42<small>页</small>');
  expect(html).toContain('<b>20<small>页</small>');
  expect(html).toContain('其中会员权益内交付 11 页');
  expect(html).toContain('2026-10-01：交付 17 页');
  expect(html).toContain('<td>2026-10-01</td><td>7</td><td>17</td>');
  expect(html.match(/class="nc-stat"/g)).toHaveLength(3);
  expect(html).not.toMatch(/重绘|翻译方式分布/);
});
