import {msg} from '../i18n/runtime';
import type {Api} from '../api';
import type {Session} from '../auth/model';
import type {Entitlements} from '../types';
import {Icon} from '../icons';
import {MembershipCard} from './MembershipCard';
import {PageTitle} from './components';
import {EntitlementCards} from './Entitlements';
import {AccountUsage} from './Usage';
import {FeedbackInbox} from './Feedback';
import './account.css';

export function AccountPage({api,account,rights,testing,onLogin,onLogout,onEntitlements}:{api:Api;account:Session|null;rights?:Entitlements;testing:boolean;onLogin:()=>void;onLogout:()=>void;onEntitlements:(value:Entitlements)=>void}) {
  const plus=rights?.plan==='plus';
  return <div className="nc-account-page">
    <PageTitle eyebrow={msg("YOUR READING SPACE")} title={msg("我的账户")} description={msg("会员权益、翻译用量与反馈，在这里一目了然。")}/>
    <div className="nc-account-overview">
      <section className="nc-profile-card">
        <div className="nc-profile-identity"><span className="nc-profile-avatar">{account?account.user.name.slice(0,1).toUpperCase():<Icon name="user" size={32}/>}</span><div><span className="nc-eyebrow">{msg("HELLO, READER")}</span><h2>{account?.user.name??msg("欢迎来到 NodeLane Comics")}</h2><span className="nc-plan-badge"><Icon name={plus?'crown':'user'} size={14}/>{account?(rights?(plus?msg("PLUS 会员"):msg("普通用户")):msg("权益读取中")):msg("尚未登录")}</span></div></div>
        <p>{account?msg("留一点时间，给喜欢的故事。"):msg("登录后开启自动翻译，查看你的阅读用量。")}</p>
        <div className="nc-profile-footer"><span><Icon name="shield" size={16}/>{account?(testing?msg("本地测试账户"):msg("账户已连接")):msg("原图阅读无需登录")}</span><button className="button quiet small" onClick={account?onLogout:onLogin}><Icon name={account?'logout':'arrow'} size={16}/>{account?msg("退出登录"):msg("登录账户")}</button></div>
      </section>
      <MembershipCard api={api} loggedIn={!!account} rights={rights} onLogin={onLogin} onEntitlements={onEntitlements}/>
    </div>
    {account?<><EntitlementCards data={rights}/><section className="nc-account-activity" aria-label={msg("翻译用量")}><AccountUsage api={api} onLogin={onLogin} onEntitlements={onEntitlements}/></section><FeedbackInbox api={api}/></>:<section className="nc-account-empty"><Icon name="chart" size={32}/><h2>{msg("你的阅读足迹，即将在这里展开")}</h2><p>{msg("登录后查看重绘额度、每日交付和反馈进展。")}</p><button className="button primary" onClick={onLogin}>{msg("登录账户")}<Icon name="arrow" size={17}/></button></section>}
  </div>;
}
