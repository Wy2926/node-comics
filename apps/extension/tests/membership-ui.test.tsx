import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Api} from '../src/api';
import type {Session} from '../src/auth/model';
import type {BillingStatus} from '../src/billing';
import type {Entitlements,UsageSummary} from '../src/types';
import {installDictionary} from '../src/i18n/runtime';
import {AccountPage} from '../src/ui/Account';
import {EntitlementCards} from '../src/ui/Entitlements';
import {MembershipCard} from '../src/ui/MembershipCard';
import {AccountUsage} from '../src/ui/Usage';
import {billingOffer} from './billing-fixture-data';

// Render the loaded API snapshot without running browser effects or making requests.
// Subsequent state (cycle, errors and child controls) keeps its ordinary initial value.
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
  environment:'test',trial_eligible:true,checkout_pending:false,checkout_price:null,checkout_provider:null,
  entitlement_expires_at:null,gift:null,subscription:null,...extra,
});
function membership(billing:BillingStatus){
  view.states=[billing,undefined];
  return renderToStaticMarkup(<MembershipCard api={api} loggedIn rights={rights()} onLogin={noop} onEntitlements={noop} notify={noop}/>);
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

it('identifies Lite as a member and keeps existing paid accounts out of the free badge',()=>{
  const account:Session={id:'fixture',token:'synthetic',expiresAt:1,refreshAt:0,credential:{kind:'development'},apiOrigin:api.base,user:{id:'fixture',name:'Reader',role:'reader'}};
  for(const [plan,label] of [['lite','Lite 会员'],['plus','会员'],['free','普通用户']] as const){
    const html=renderToStaticMarkup(<AccountPage api={api} account={account} rights={rights(plan)} testing={false} tab="subscription" onTabChange={noop} onLogin={noop} onLogout={noop} onEntitlements={noop} notify={noop}/>);
    const badge=html.match(/<span class="nc-plan-badge">(.*?)<\/span>/)?.[1];
    expect(badge).toContain(label);
    if(plan!=='free')expect(badge).not.toContain('普通用户');
  }
});

it('offers only actual Lite prices for new purchases and shows their returned benefits',()=>{
  const legacy={...billingOffer,id:'legacy-price',plan_id:'plus',name:'PLUS',unit_amount:999};
  const lite={...billingOffer,hourly_image_limit:741};
  const html=membership(status({offers:[legacy,lite]}));
  expect(html).toContain('NODELANE COMICS Lite');
  expect(html).toContain('US$5.99');
  expect(html).toContain('每滚动小时最多新增 741 页翻译');
  expect(html).toContain('首次试用 7 天。');
  expect(html).not.toMatch(/PLUS|US\$9\.99|重绘/);
});

it('keeps the original subscription name and price for managing an existing paid contract',()=>{
  const price={...billingOffer,id:'legacy-contract',plan_id:'plus',name:'Existing subscription',unit_amount:999,hourly_image_limit:null};
  const html=membership(status({trial_eligible:false,subscription:{provider:'creem',price,status:'active',next_billed_at:null,cancel_at:null,trial_ends_at:null,paid_ends_at:null,auto_renew:true,can_cancel:true,renewal_state:'normal',resume_at:null}}));
  expect(html).toContain('NODELANE COMICS Existing subscription');
  expect(html).toContain('US$9.99');
  expect(html).toContain('管理订阅');
  expect(html).not.toMatch(/每滚动小时|重绘|首次试用/);
});

it('retains the pending checkout price rather than replacing it with the new Lite offer',()=>{
  const pending={...billingOffer,id:'original-price',plan_id:'plus',name:'Original quote',unit_amount:799};
  const html=membership(status({checkout_price:pending,checkout_provider:'creem',checkout_pending:true}));
  expect(html).toContain('NODELANE COMICS Original quote');
  expect(html).toContain('US$7.99');
  expect(html).toContain('继续原结账');
  expect(html).not.toContain('US$5.99');
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
