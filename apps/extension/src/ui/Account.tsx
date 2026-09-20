import {msg} from '../i18n/runtime';
import type {Api} from '../api';
import type {Session} from '../auth/model';
import type {Entitlements} from '../types';
import {Icon} from '../icons';
import {MembershipCard} from './MembershipCard';
import {EntitlementCards} from './Entitlements';
import {AccountUsage} from './Usage';
import {FeedbackInbox} from './Feedback';
import './account.css';

// Temporarily hide the subscription offer; keep the billing component ready to reopen.
const SHOW_PLUS_CARD=false;

export function AccountPage({api,account,rights,testing,onLogin,onLogout,onEntitlements,notify}:{api:Api;account:Session|null;rights?:Entitlements;testing:boolean;onLogin:()=>void;onLogout:()=>void;onEntitlements:(value:Entitlements)=>void;notify:(message:string)=>void}) {
  const plus=!!account&&rights?.plan==='plus';
  return <div className="nc-account-page">
    <header className="page-title nc-account-heading">
      <div><span className="eyebrow muted">{msg("YOUR READING SPACE")}</span><h1>{msg("我的账户")}</h1><p>{msg("会员权益、翻译用量与反馈，在这里一目了然。")}</p></div>
      <div className="nc-account-identity">
        <span className="nc-profile-avatar" aria-hidden="true">{account?account.user.name.slice(0,1).toUpperCase():<Icon name="user" size={24}/>}</span>
        <div className="nc-account-user"><strong>{account?.user.name??msg("欢迎来到 NodeLane Comics")}</strong><div className="nc-account-meta"><span className="nc-plan-badge"><Icon name={plus?'crown':'user'} size={14}/>{account?(rights?(plus?msg("PLUS 会员"):msg("普通用户")):msg("权益读取中")):msg("尚未登录")}</span>{testing&&account&&<span className="nc-muted">{msg("本地测试账户")}</span>}</div></div>
        <button className="button quiet small" onClick={account?onLogout:onLogin}><Icon name={account?'logout':'arrow'} size={16}/>{account?msg("退出登录"):msg("登录账户")}</button>
      </div>
    </header>
    {(account||SHOW_PLUS_CARD)&&<div className={'nc-account-overview'+(SHOW_PLUS_CARD&&account?' has-membership-card':'')}>
      {account&&<EntitlementCards data={rights}/>}
      {SHOW_PLUS_CARD&&<MembershipCard api={api} loggedIn={!!account} rights={rights} onLogin={onLogin} onEntitlements={onEntitlements} notify={notify}/>}
    </div>}
    {account?<><section className="nc-account-activity" aria-label={msg("翻译用量")}><AccountUsage api={api} onLogin={onLogin} onEntitlements={onEntitlements}/></section><FeedbackInbox api={api}/></>:<section className="nc-account-empty"><Icon name="chart" size={32}/><h2>{msg("你的阅读足迹，即将在这里展开")}</h2><p>{msg("登录后查看重绘额度、每日交付和反馈进展。")}</p><button className="button primary" onClick={onLogin}>{msg("登录账户")}<Icon name="arrow" size={17}/></button></section>}
  </div>;
}
