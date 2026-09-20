import {useEffect,useId,useRef} from 'react';
import {Icon} from '../icons';
import type {useLogin} from '../auth/useLogin';
import './login.css';

export function Login({login}:{login:ReturnType<typeof useLogin>}){
  const {open,setOpen,state}=login;
  const pending=state.kind==='pending';
  if(!open)return state.kind==='idle'?null:<button className={`nc-login-resume ${state.kind}`} aria-label={pending?'登录进行中，展开阅读通行证':'登录未完成，查看原因并重试'} onClick={()=>setOpen(true)}>
    <span className="nc-login-bookmark">{pending?<span className="spinner"/>:<Icon name="info"/>}</span>
    <span role="status" aria-live="polite" aria-atomic="true">{pending?'登录进行中':'登录未完成'}<small>{pending?'展开阅读通行证':'查看原因并重试'}</small></span><Icon name="arrow" size={18}/>
  </button>;
  return <LoginDialog login={login}/>;
}

function LoginDialog({login}:{login:ReturnType<typeof useLogin>}){
  const {setOpen,state,development,config,configLoading,configError,username,setUsername,authenticate,reloadConfig}=login;
  const ref=useRef<HTMLDialogElement>(null),titleId=useId();
  useEffect(()=>{
    const trigger=document.activeElement;
    ref.current?.showModal();
    return()=>{if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus({preventScroll:true});};
  },[]);
  const pending=state.kind==='pending';
  const configured=development||config?.mode==='oidc'&&Boolean(config.authorization_endpoint&&config.token_endpoint&&config.client_id);
  const unavailable=!configLoading&&!configured;
  const failed=state.kind==='error'||unavailable;
  return <dialog ref={ref} className={`modal nc-login ${pending?'is-connecting':''} ${failed?'has-error':''}`} aria-labelledby={titleId} onCancel={event=>{event.preventDefault();setOpen(false);}}>
    <button className="nc-login-close icon-button" aria-label={pending?'收起登录进度':'关闭登录'} onClick={()=>setOpen(false)}><Icon name="close"/></button>
    <div className="nc-login-spread">
      <div className="nc-login-cover" aria-hidden="true">
        <div className="nc-login-masthead"><Icon name="spark" size={18}/><span>NODE COMICS</span><span>漫游通行证</span></div>
        <div className="nc-login-cover-title">翻过语言<br/><em>这一页。</em><span className="nc-login-star">✳</span></div>
        <div className="nc-login-panels">
          <div className="nc-login-panel original"><span className="nc-login-panel-label">01 / 原文</span><span className="nc-login-letter">あ</span><span className="nc-login-bubble">えっ？</span></div>
          <div className="nc-login-panel translated"><span className="nc-login-panel-label">02 / 读懂</span><span className="nc-login-letter">啊</span><span className="nc-login-bubble">{failed?'再试一次！':pending?'连接中…':'原来如此！'}</span></div>
          <span className="nc-login-panel-arrow"><Icon name="arrow" size={26}/></span>
        </div>
        <div className="nc-login-cover-bottom"><span>每个故事，都值得读懂。</span><span>READ<br/>BEYOND WORDS ↗</span></div>
      </div>
      <div className="nc-login-content">
        <span className="nc-login-kicker"><span/> YOUR NEXT CHAPTER</span>
        <h2 id={titleId}>登录，接着看。</h2>
        <p className="nc-login-intro">让喜欢的故事，用你的语言继续。</p>
        <form onSubmit={event=>{event.preventDefault();if(!pending&&!configLoading&&configured)void authenticate();}}>
          {development&&<label className="field nc-login-field">测试用户名<input autoComplete="username" value={username} maxLength={60} disabled={pending} required onChange={event=>setUsername(event.target.value)} placeholder="例如 reader"/></label>}
          <div className={`nc-login-status ${state.kind==='error'?'error':unavailable?'unavailable':pending?'pending':''}`}>
            {state.kind==='error'?<div role="alert" aria-atomic="true"><Icon name="info"/><div><strong>这次没能完成登录</strong><p>{state.message}</p><small>原图和阅读位置已保留，可以再次尝试。</small></div></div>
              :pending?<div role="status" aria-live="polite" aria-atomic="true"><span className="spinner"/><div><strong>{state.message}</strong><p>{development?'连接完成后，会自动回到这里。':'完成后会自动回到这里。若已关闭登录窗口，请等待返回结果后重试。'}</p><small>也可以收起进度，继续阅读原图。</small></div></div>
              :configLoading?<div role="status"><span className="spinner"/><div><strong>正在准备登录</strong><p>正在连接账户服务，请稍候。</p></div></div>
              :unavailable?<div role="alert"><Icon name="info"/><div><strong>登录服务暂不可用</strong><p>{configError||'身份服务尚未配置完整，请稍后重试或联系运营方。'}</p></div></div>
              :<div><Icon name="shield"/><div><strong>{development?'开发环境 · 测试登录':'你的下一页，已准备好'}</strong><p>{development?'此入口仅用于本地开发验证。':'前往安全登录页面，完成后回到这里。'}</p></div></div>}
          </div>
          {unavailable&&!pending?<button type="button" className="button primary full nc-login-submit" onClick={()=>void reloadConfig()}>重新连接登录服务<Icon name="refresh" size={18}/></button>
            :<button type="submit" className="button primary full nc-login-submit" disabled={pending||configLoading||!configured||development&&!username.trim()}>{pending?<><span className="spinner"/>等待登录完成</>:configLoading?'准备登录中…':<>{state.kind==='error'?'重新登录':development?'连接测试账户':'登录，开启漫游'}<Icon name="arrow" size={18}/></>}</button>}
          <button type="button" className="button quiet full nc-login-later" onClick={()=>setOpen(false)}>{pending?'收起进度，继续阅读':'先阅读原图'}</button>
        </form>
        <div className="nc-login-footnote"><Icon name="book" size={17}/><p>当前页与后两页，随读随译。<br/><span>原图与阅读位置，始终为你保留。</span></p></div>
      </div>
    </div>
  </dialog>;
}
