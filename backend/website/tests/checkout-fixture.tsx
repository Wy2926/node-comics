import {createRoot} from 'react-dom/client';
import BillingOffers from '../src/components/BillingOffers';
import {dictionaries} from '../src/i18n';
import {localPath,locales,type Locale} from '../src/i18n/locales';
import {fixtureCatalog,signOut} from './account-fixture-auth';
import '../src/styles/global.css';
import '../src/styles/controls.css';
import '../src/styles/header.css';
import '../src/styles/public-site.css';
import '../src/styles/marketing.css';
import '../src/styles/rtl.css';
if(location.port!=='5193')throw Error('Use isolated port 5193.');
const selected=new URLSearchParams(location.search).get('locale') as Locale;
const locale=locales.includes(selected)?selected:'zh-CN',d=dictionaries[locale],t=d.ui;
const accountText=(key:string)=>d.account?.[key]??key;
document.documentElement.lang=locale;
document.documentElement.dir=locale==='ar'?'rtl':'ltr';
document.body.dataset.siteTheme='midnight';
document.body.dataset.page='/pricing/';
window.fetch=async input=>{
  if(String(input)==='/v1/billing/catalog')return new Response(JSON.stringify(fixtureCatalog()),{status:200,headers:{'Content-Type':'application/json'}});
  throw Error('No external requests allowed in this fixture');
};
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1200,margin:'32px auto',padding:24}}>
  <h1>{t.pricing} · 隔离验收</h1><p>所有金额和数量仅为测试夹具。不连接真实身份或支付服务，响应丢失后不自动重发。</p>
  <p id="checkout-observation" role="status">等待操作</p><button type="button" onClick={()=>void signOut()}>模拟另一个标签页退出</button>
  <BillingOffers locale={locale} accountHref={localPath('/account/',locale)} downloadHref={localPath('/download/',locale)}
    checkoutCopy={{busy:accountText('正在确认登录结果，请稍候…'),error:accountText('操作暂未完成，请重试或重新登录。'),before:accountText('继续前请阅读'),refund:accountText('订阅与退款说明'),renewal:accountText('，了解自动续费规则。'),resume:accountText('继续原结账')}}
    free={{name:t.freePlan,description:t.freePlanDescription,action:t.freeStart,note:t.freeNote,priceLabel:t.free}}/>
</main>);
