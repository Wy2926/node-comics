import {beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Api} from '../src/api';
import type {Session} from '../src/auth/model';
import type {Entitlements} from '../src/types';
import {installDictionary} from '../src/i18n/runtime';
import {AccountPage} from '../src/ui/Account';
import {EntitlementCards} from '../src/ui/Entitlements';
import {QuotaPurchaseCard} from '../src/ui/QuotaPurchases';
import {purchaseFixtures} from './quota-purchases-fixture-data';

beforeEach(()=>installDictionary('zh-CN',{}));
const noop=()=>{};
const api=new Api('https://membership.fixture.test','synthetic');
const balance=(available:number)=>({granted:available,used:0,reserved:0,available,next_expiry_at:null,resets_at:null});
const rights:Entitlements={plan:'custom',plan_name:'后台配置的套餐',plus_started_at:null,plus_expires_at:'2026-10-20T00:00:00Z',timezone:'Asia/Shanghai',generated_at:'2026-10-09',pending_previous_period_pages:0,
  image_rate_limit:{limit:37,window_seconds:60},free_quota:balance(6),subscription_quota:{...balance(2457),unlimited:false},purchase_quota:balance(3195),
  modes:{classic:{allowed:true,unlimited:false,quota_kind:'classic_monthly',consent_version:'fixture',quota:null}}};
const account:Session={id:'fixture',token:'synthetic',expiresAt:1,refreshAt:0,credential:{kind:'development'},apiOrigin:api.base,user:{id:'fixture',name:'Reader',role:'reader'}};
const renderAccount=(data=rights,session:Session|null=account)=>renderToStaticMarkup(<AccountPage api={api} account={session} rights={data} testing={false} onLogin={noop} onLogout={noop} onEntitlements={noop}/>);

it('uses server names and expiry, with one pricing link and no old subscription layout or billing operations',()=>{
  const html=renderAccount();
  for(const text of ['后台配置的套餐','有效至 2026/10/20 08:00:00','前往定价页面','刷新权益'])expect(html).toContain(text);
  expect(html).toContain('href="https://comics.nodelane.net/pricing/"');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).not.toMatch(/PLUS|Pro|Lite|US\$|自动续费|管理订阅|role="tab"|nc-membership|翻译请求频率/);
  expect(html).toContain('用量与反馈');
  expect(html).not.toContain('nc-bar-chart');
});

it('does not promote a pack-only account to membership or show another membership expiry',()=>{
  const html=renderAccount({...rights,plan:'free',plan_name:'free',plus_expires_at:null,service_plan:'custom'});
  expect(html).toContain('普通用户');
  expect(html).toContain('3,195');
  expect(html).not.toContain('有效至');
});

it('keeps named SVG pricing and refresh controls in the account header without a standalone action row',()=>{
  const html=renderAccount(),heading=html.split('</header>')[0];
  expect(heading).toContain('class="nc-account-toolbar"');
  expect(heading).toContain('aria-label="前往定价页面" title="前往定价页面"');
  expect(heading).toContain('#pricing');
  expect(heading).toContain('aria-label="刷新权益" title="刷新权益" aria-busy="false"');
  expect(heading).toContain('#refresh');
  expect(html).not.toContain('nc-account-actions');
});

it('shows only login guidance before login',()=>{
  const html=renderAccount(rights,null);
  expect(html).toContain('登录账户');
  expect(html).not.toMatch(/前往定价页面|后台配置的套餐|nc-rights-card/);
});

it.each([[2,5,false],[0,0,false],[0,0,true]] as const)('separates three balances %i %i unlimited %s without a combined legacy quota', (free,subscription,unlimited)=>{
  const html=renderToStaticMarkup(<EntitlementCards data={{...rights,free_quota:balance(free),subscription_quota:{...balance(subscription),unlimited}}}/>);
  const cards=html.split('<article').slice(1);
  expect(cards).toHaveLength(3);
  expect(cards[0]).toContain(`<strong>${free}<small>页可用</small>`);
  expect(cards[1]).toContain(unlimited?'<strong>不限量</strong>':`<strong>${subscription}<small>页可用</small>`);
  expect(html.match(/免费模型先扣免费额度/g)).toHaveLength(1);
});

it('keeps exhausted periodic boundaries separate from grant expiry without promising renewal',()=>{
  const html=renderToStaticMarkup(<EntitlementCards data={{...rights,
    free_quota:{...balance(0),next_expiry_at:'2026-10-09T12:00:00Z',resets_at:'2026-10-09T16:00:00Z'},
    subscription_quota:{...balance(0),unlimited:false,resets_at:'2026-10-20T00:00:00Z'}}}/>);
  expect(html).toContain('下次恢复 2026/10/10 00:00:00');
  expect(html).toContain('本期结束 2026/10/20 08:00:00');
  expect(html).not.toContain('2026/10/9 20:00:00');
});

it('shows server-supplied pack name, pages, dates without internal fields or product assumptions',()=>{
  const item={...purchaseFixtures[0],product_name:'任意后台商品名',granted:4321,available:4016,note:'private operator note'};
  const html=renderToStaticMarkup(<QuotaPurchaseCard item={item} timezone="Asia/Shanghai"/>);
  for(const text of ['任意后台商品名','4,016','共 4,321 页','已用 300 页 · 处理中 5 页','2026/10/8 16:30:00','不过期'])expect(html).toContain(text);
  expect(html).not.toMatch(/private operator note|synthetic-order|自动续费|PLUS|US\$/);
});

it.each([['scheduled','待生效'],['exhausted','无可用额度'],['expired','已到期'],['revoked','已撤销']] as const)('shows server %s state with zero spendable balance', (state,label)=>{
  const html=renderToStaticMarkup(<QuotaPurchaseCard item={{...purchaseFixtures[0],state,available:0,expires_at:'2026-10-20T00:00:00Z'}} timezone="Asia/Shanghai"/>);
  expect(html).toContain(label);
  expect(html).toContain('<strong>0</strong>');
  expect(html).toContain('2026/10/20 08:00:00');
  expect(html).not.toContain('不过期');
});

it('does not request history before expanding it, even with zero remaining balance',()=>{
  const request=vi.spyOn(api,'quotaPurchases');
  const html=renderToStaticMarkup(<EntitlementCards api={api} data={{...rights,purchase_quota:balance(0)}}/>);
  expect(html).toContain('查看额度包');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('class="nc-purchases"');
  expect(request).not.toHaveBeenCalled();
  request.mockRestore();
});
