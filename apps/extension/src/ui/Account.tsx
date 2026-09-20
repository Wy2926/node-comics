import {Fragment} from 'react';
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

export type AccountTab='overview'|'subscription';
export function AccountPage({api,account,rights,testing,tab,onTabChange,onLogin,onLogout,onEntitlements,notify}:{api:Api;account:Session|null;rights?:Entitlements;testing:boolean;tab:AccountTab;onTabChange:(tab:AccountTab)=>void;onLogin:()=>void;onLogout:()=>void;onEntitlements:(value:Entitlements)=>void;notify:(message:string)=>void}) {
  const plus=!!account&&rights?.plan==='plus';
  return <div className="nc-account-page">
    <header className="page-title nc-account-heading">
      <div><span className="eyebrow muted">{msg("YOUR READING SPACE")}</span><h1>{msg("我的账户")}</h1><p>{msg("会员权益、翻译用量与反馈，在这里一目了然。")}</p></div>
      {account&&<div className="nc-account-identity">
        <span className="nc-profile-avatar" aria-hidden="true">{account.user.name.slice(0,1).toUpperCase()}</span>
        <div className="nc-account-user"><strong>{account.user.name}</strong><div className="nc-account-meta"><span className="nc-plan-badge"><Icon name={plus?'crown':'user'} size={14}/>{rights?(plus?msg("PLUS 会员"):msg("普通用户")):msg("权益读取中")}</span>{testing&&<span className="nc-muted">{msg("本地测试账户")}</span>}</div></div>
        <button className="button quiet small" onClick={onLogout}><Icon name="logout" size={16}/>{msg("退出登录")}</button>
      </div>}
    </header>
    {account?<Fragment key={account.id}>
      <div className="nc-work-tabs nc-account-tabs" role="tablist" aria-label={msg("我的账户")}>
        {(['overview','subscription'] as const).map(value=><button key={value} id={`account-tab-${value}`} role="tab" aria-selected={tab===value} aria-controls={`account-panel-${value}`} tabIndex={tab===value?0:-1} onClick={()=>onTabChange(value)} onKeyDown={event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          event.preventDefault();const next=event.key==='Home'?'overview':event.key==='End'?'subscription':value==='overview'?'subscription':'overview';
          onTabChange(next);document.getElementById(`account-tab-${next}`)?.focus();
        }}>{value==='overview'?msg('账户概览'):msg('订阅')}</button>)}
      </div>
      <div className="nc-account-panel" id={`account-panel-${tab}`} role="tabpanel" aria-labelledby={`account-tab-${tab}`} tabIndex={0}>
        {tab==='overview'?<><EntitlementCards data={rights}/><section className="nc-account-activity" aria-label={msg("翻译用量")}><AccountUsage api={api} onLogin={onLogin} onEntitlements={onEntitlements}/></section><FeedbackInbox api={api}/></>:<MembershipCard api={api} loggedIn rights={rights} onLogin={onLogin} onEntitlements={onEntitlements} notify={notify}/>}
      </div>
    </Fragment>:<section className="nc-account-empty"><Icon name="chart" size={32}/><h2>{msg("你的阅读足迹，即将在这里展开")}</h2><p>{msg("登录后查看重绘额度、每日交付和反馈进展。")}</p><button className="button primary" onClick={onLogin}>{msg("登录账户")}<Icon name="arrow" size={17}/></button></section>}
  </div>;
}
