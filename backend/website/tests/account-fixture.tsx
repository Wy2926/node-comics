import {createRoot} from 'react-dom/client';
import {useEffect} from 'react';
import Account from '../src/components/Account';
import {observeAccountFixture,switchFixtureAccount,signOut} from './account-fixture-auth';
import '../src/styles/global.css';
import '../src/styles/controls.css';
import '../src/styles/header.css';
import '../src/styles/public-site.css';
import '../src/styles/marketing.css';
import '../src/styles/rtl.css';
import {dictionaries} from '../src/i18n';
import type {Locale} from '../src/i18n/types';
import {localPath} from '../src/i18n/locales';
if(location.port!=='5193')throw Error('Use isolated port 5193.');
const locale=(new URLSearchParams(location.search).get('locale')||'zh-CN') as Locale;
const d=dictionaries[locale];
document.documentElement.lang=locale;
document.documentElement.dir=locale==='ar'?'rtl':'ltr';
document.body.dataset.siteTheme='midnight';
document.body.dataset.page='/account/';
function Fixture(){
  useEffect(observeAccountFixture,[]);
  return <main style={{maxWidth:1000,margin:'32px auto',padding:24}}><header style={{maxWidth:760,margin:'0 auto 28px'}}><h1>{d.ui.accountTitle}</h1><p>{d.ui.accountDescription}</p></header><Account locale={locale} copy={d.account} accountHref={localPath('/account/',locale)}/>{new URLSearchParams(location.search).has('perf')&&<aside style={{marginTop:24}}><p>隔离性能验收：仅模拟数据，不连接登录或支付服务；时间从夹具模块初始化起计。</p><button onClick={switchFixtureAccount}>模拟切换账户</button> <button onClick={()=>void signOut()}>模拟其他标签页退出</button><pre><output id="account-fixture-observation"/></pre></aside>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
