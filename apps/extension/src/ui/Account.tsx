import {useEffect,useRef,useState} from 'react';
import {msg,getLocale} from '../i18n/runtime';
import type {Api} from '../api';
import type {Session} from '../auth/model';
import type {Entitlements} from '../types';
import {pricingUrl} from '../billing';
import {Icon} from '../icons';
import {EntitlementCards} from './Entitlements';
import {AccountUsage} from './Usage';
import {FeedbackInbox} from './Feedback';
import './account.css';

type AccountProps={api:Api;account:Session|null;rights?:Entitlements;testing:boolean;onLogin:()=>void;onLogout:()=>void;onEntitlements:(value:Entitlements)=>void};

function AccountContent({api,account,rights,testing,onLogout,onEntitlements,onLogin}:AccountProps&{account:Session}){
  const member=!!rights&&rights.plan!=='free';
  const [refreshing,setRefreshing]=useState(false),[error,setError]=useState(false),[activity,setActivity]=useState(false);
  const [revision,setRevision]=useState(0);
  const pending=useRef(false),generation=useRef(0),fromPricing=useRef(false);
  async function refresh(){
    if(pending.current)return;
    const current=generation.current;
    pending.current=true;setRefreshing(true);setError(false);
    try{
      const value=await api.entitlements(true);
      if(current===generation.current&&api.isCurrent()){onEntitlements(value);setRevision(value=>value+1);}
    }catch{if(current===generation.current&&api.isCurrent())setError(true);}
    finally{if(current===generation.current){pending.current=false;setRefreshing(false);}}
  }
  useEffect(()=>{
    const returned=()=>{if(fromPricing.current&&!document.hidden){fromPricing.current=false;void refresh();}};
    window.addEventListener('focus',returned);document.addEventListener('visibilitychange',returned);
    return()=>{generation.current++;pending.current=false;window.removeEventListener('focus',returned);document.removeEventListener('visibilitychange',returned);};
  },[api,onEntitlements]);
  return <>
    <header className="page-title nc-account-heading">
      <h1>{msg('我的账户')}</h1>
      <div className="nc-account-identity">
        <span className="nc-profile-avatar" aria-hidden="true">{account.user.name.slice(0,1).toUpperCase()}</span>
        <div className="nc-account-user"><strong>{account.user.name}</strong><div className="nc-account-meta">
          <span className="nc-plan-badge"><Icon name={member?'crown':'user'} size={14}/>{rights?(member?rights.plan_name??rights.plan:msg('普通用户')):msg('权益读取中')}</span>
          {member&&rights?.plus_expires_at&&<span>{msg('有效至 {0}',{'0':new Date(rights.plus_expires_at).toLocaleString(getLocale(),{timeZone:rights.timezone})})} · {rights.timezone}</span>}
          {testing&&<span>{msg('本地测试账户')}</span>}
        </div></div>
        <button className="button quiet small" onClick={onLogout}><Icon name="logout" size={16}/>{msg('退出登录')}</button>
      </div>
      <div className="nc-account-toolbar">
        <button className="icon-button" aria-label={msg('刷新权益')} title={refreshing?msg('处理中…'):msg('刷新权益')} aria-busy={refreshing} disabled={refreshing} onClick={()=>void refresh()}><Icon name="refresh" size={24} style={{stroke:'currentColor'}}/></button>
        <a className="icon-button" href={pricingUrl(getLocale())} target="_blank" rel="noopener noreferrer" aria-label={msg('前往定价页面')} title={msg('前往定价页面')} onClick={()=>{fromPricing.current=true;}}><Icon name="pricing" size={28}/></a>
      </div>
    </header>
    {error&&<p className="nc-error" role="alert">{msg('暂时无法读取权益，请重试。')}</p>}
    <EntitlementCards api={api} data={rights} revision={revision}/>
    <details className="nc-account-activity" onToggle={event=>setActivity(event.currentTarget.open)}>
      <summary>{msg('用量与反馈')}</summary>
      {activity&&<><AccountUsage api={api} onLogin={onLogin} onEntitlements={onEntitlements}/><FeedbackInbox api={api}/></>}
    </details>
  </>;
}

export function AccountPage({account,...props}:AccountProps){
  return <div className="nc-account-page">
    {account?<AccountContent key={account.id} account={account} {...props}/>:<>
      <header className="page-title nc-account-heading"><h1>{msg('我的账户')}</h1></header>
      <section className="nc-account-empty"><Icon name="chart" size={32}/><h2>{msg('你的阅读足迹，即将在这里展开')}</h2><p>{msg('登录后查看翻译额度、每日交付和反馈进展。')}</p><button className="button primary" onClick={props.onLogin}>{msg('登录账户')}<Icon name="arrow" size={17}/></button></section>
    </>}
  </div>;
}
