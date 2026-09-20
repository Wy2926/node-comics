import {msg,getLocale} from '../i18n/runtime';
import type {Api} from '../api';
import type {Session} from '../auth/model';
import type {Entitlements} from '../types';
import {Icon} from '../icons';
import {WEBSITE_UPGRADE_URL} from '../service';
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
      <section className="nc-membership-card">
        <div className="nc-membership-heading"><span className="nc-icon-tile"><Icon name="crown" size={26}/></span><span className="nc-eyebrow">NODELANE COMICS PLUS</span><Icon name="spark" size={28}/></div>
        <h2>{plus?msg("让精彩，继续翻页"):msg("为热爱，多翻一页")}</h2>
        <p>{plus?msg("感谢你的支持。会员与订阅服务将在官网统一管理。"):msg("前往官网了解 PLUS，选择适合你的阅读权益。")}</p>
        <div className="nc-membership-footer">{WEBSITE_UPGRADE_URL?<a className="button primary" href={WEBSITE_UPGRADE_URL} target="_blank" rel="noopener noreferrer">{plus?msg("前往官网管理"):msg("前往官网升级")}<Icon name="external" size={16}/></a>:<span className="nc-coming-soon"><Icon name="external" size={16}/>{msg("官网升级即将开放")}</span>}<span>{plus&&rights?.plus_expires_at?msg("有效至 {0}", {"0": new Date(rights.plus_expires_at).toLocaleDateString(getLocale())}):msg("在官网完成升级与订阅管理")}</span></div>
      </section>
    </div>
    {account?<><EntitlementCards data={rights}/><section className="nc-account-activity" aria-label={msg("翻译用量")}><AccountUsage api={api} onLogin={onLogin} onEntitlements={onEntitlements}/></section><FeedbackInbox api={api}/></>:<section className="nc-account-empty"><Icon name="chart" size={32}/><h2>{msg("你的阅读足迹，即将在这里展开")}</h2><p>{msg("登录后查看重绘额度、每日交付和反馈进展。")}</p><button className="button primary" onClick={onLogin}>{msg("登录账户")}<Icon name="arrow" size={17}/></button></section>}
  </div>;
}
