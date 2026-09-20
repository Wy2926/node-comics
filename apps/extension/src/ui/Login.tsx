import {Icon} from '../icons';
import type {useLogin} from '../auth/useLogin';
import {Modal} from './components';
import './login.css';

export function Login({login}:{login:ReturnType<typeof useLogin>}){
  const {open,setOpen,state,development,config,configLoading,configError,username,setUsername,authenticate,reloadConfig}=login;
  const pending=state.kind==='pending';
  const configured=development||config?.mode==='oidc'&&Boolean(config.authorization_endpoint&&config.token_endpoint&&config.client_id);
  const unavailable=!configLoading&&!configured;
  if(!open)return state.kind==='idle'?null:<button className={`nc-login-resume ${state.kind}`} onClick={()=>setOpen(true)}>
    {pending?<span className="spinner"/>:<Icon name="info"/>}
    <span>{pending?'登录进行中':'登录未完成'}<small>{pending?'查看进度':'查看原因并重试'}</small></span><Icon name="arrow" size={18}/>
  </button>;
  return <Modal className="nc-login" title="让故事，没有语言的距离。" subtitle="连接漫游账户，开启随读随译。" closeLabel={pending?'收起登录进度':'关闭登录'} onClose={()=>setOpen(false)}>
    <div className="nc-login-benefits"><Icon name="book" size={19}/><span>原图随时读</span><span aria-hidden="true">·</span><span>阅读位置保留</span></div>
    <form onSubmit={event=>{event.preventDefault();if(!pending&&!configLoading&&configured)void authenticate();}}>
      {development&&<label className="field nc-login-field">测试用户名<input autoComplete="username" value={username} maxLength={60} disabled={pending} required onChange={event=>setUsername(event.target.value)} placeholder="例如 reader"/></label>}
      <div className={`nc-login-status ${state.kind==='error'?'error':unavailable?'unavailable':pending?'pending':''}`}>
        {state.kind==='error'?<div role="alert" aria-atomic="true"><Icon name="info"/><div><strong>这次没能完成登录</strong><p>{state.message}</p><small>原图和阅读位置已保留，可以再次尝试。</small></div></div>
          :pending?<div role="status" aria-live="polite" aria-atomic="true"><span className="spinner"/><div><strong>{state.message}</strong><p>{development?'连接完成后，会自动回到这里。':'完成后会自动回到这里。若已关闭登录窗口，请等待返回结果后重试。'}</p><small>也可以收起进度，继续阅读原图。</small></div></div>
          :configLoading?<div role="status"><span className="spinner"/><div><strong>正在准备登录</strong><p>正在连接账户服务，请稍候。</p></div></div>
          :unavailable?<div role="alert"><Icon name="info"/><div><strong>登录服务暂不可用</strong><p>{configError||'身份服务尚未配置完整，请稍后重试或联系运营方。'}</p></div></div>
          :<div><Icon name="shield"/><div><strong>{development?'开发环境 · 测试登录':'安全连接你的账户'}</strong><p>{development?'此入口仅用于本地开发验证。':'将打开安全登录页面，完成后自动返回。'}</p></div></div>}
      </div>
      {unavailable&&!pending?<button type="button" className="button primary full nc-login-submit" onClick={()=>void reloadConfig()}>重新连接登录服务<Icon name="refresh" size={18}/></button>
        :<button type="submit" className="button primary full nc-login-submit" disabled={pending||configLoading||!configured||development&&!username.trim()}>{pending?<><span className="spinner"/>等待登录完成</>:configLoading?'准备登录中…':<>{state.kind==='error'?'重新登录':development?'连接测试账户':'继续登录'}<Icon name="arrow" size={18}/></>}</button>}
      <button type="button" className="button quiet full nc-login-later" onClick={()=>setOpen(false)}>{pending?'收起进度，继续阅读':'先阅读原图'}</button>
    </form>
    <p className="nc-login-footnote"><Icon name="spark" size={15}/>登录后，当前页与后两页会自动翻译</p>
  </Modal>;
}
